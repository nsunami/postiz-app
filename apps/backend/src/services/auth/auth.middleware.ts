import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { User } from '@prisma/client';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { getCookieUrlFromDomain } from '@gitroom/helpers/subdomain/subdomain.management';
import { HttpForbiddenException } from '@gitroom/nestjs-libraries/services/exception.filter';
import { MastraService } from '@gitroom/nestjs-libraries/chat/mastra.service';
import { setSentryUserContext } from '@gitroom/nestjs-libraries/sentry/initialize.sentry';

/**
 * Small in-process TTL cache for the auth middleware hot path.
 *
 * Every request currently resolves the user and the picked organization from
 * the database. Both rarely change, so we cache the resolved (user, org) pair
 * for a short window keyed by userId + requested org. The cache is
 * per-process, cloned so each request gets its own object, and skipped for the
 * impersonation path or orgs that still need an apiKey generated. The short
 * TTL keeps any staleness from user-deactivation / org-membership revocation
 * bounded.
 */
const AUTH_CACHE_TTL_MS = 10_000;
const AUTH_CACHE_MAX_ENTRIES = 10_000;

type AuthCacheValue = {
  user: User;
  org: Record<string, any>;
};

const authCache = new Map<string, { value: AuthCacheValue; expires: number }>();

const getFromAuthCache = (key: string) => {
  const entry = authCache.get(key);
  if (!entry) {
    return null;
  }
  if (entry.expires < Date.now()) {
    authCache.delete(key);
    return null;
  }
  // Each request must get its own copy: downstream code (and the middleware
  // itself) mutates the resolved user/org objects.
  return structuredClone(entry.value);
};

const setToAuthCache = (key: string, value: AuthCacheValue) => {
  // Opportunistic eviction so the cache can't grow without bound; drop the
  // oldest entry (insertion order) instead of clearing the whole cache.
  if (authCache.size >= AUTH_CACHE_MAX_ENTRIES) {
    const oldest = authCache.keys().next().value;
    if (oldest !== undefined) {
      authCache.delete(oldest);
    }
  }
  // Clone on write too: the entries must not alias the objects handed to the
  // current request, otherwise any downstream mutation would leak into the
  // cache and be served to later requests.
  authCache.set(key, {
    value: structuredClone(value),
    expires: Date.now() + AUTH_CACHE_TTL_MS,
  });
};

export const removeAuth = (res: Response) => {
  res.cookie('auth', '', {
    domain: getCookieUrlFromDomain(process.env.FRONTEND_URL!),
    ...(!process.env.NOT_SECURED
      ? {
          secure: true,
          httpOnly: true,
          sameSite: 'none',
        }
      : {}),
    expires: new Date(0),
    maxAge: -1,
  });
  res.header('logout', 'true');
};

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private _organizationService: OrganizationService,
    private _userService: UsersService
  ) {}
  async use(req: Request, res: Response, next: NextFunction) {
    const auth = req.headers.auth || req.cookies.auth;
    if (!auth) {
      throw new HttpForbiddenException();
    }
    try {
      // Verify the JWT signature only. Never trust authorization-relevant
      // claims (id, isSuperAdmin, activated) from the token body — always
      // re-resolve the user from the database using the id.
      const payload = AuthService.verifyJWT(auth) as
        | (User & { scope?: string })
        | null;
      const orgHeader = req.cookies.showorg || req.headers.showorg;

      // Scoped tokens (like the short-lived two-factor challenge) are never
      // session tokens, even if one is somehow sent as the auth cookie.
      if (!payload?.id || typeof payload.id !== 'string' || payload.scope) {
        throw new HttpForbiddenException();
      }

      const orgHeaderString = String(
        Array.isArray(orgHeader) ? orgHeader[0] : orgHeader ?? ''
      );
      const impersonate = req.cookies.impersonate || req.headers.impersonate;

      // Serving from cache must behave exactly like a fresh resolve: skip it
      // when a super-admin impersonates another user, because the resolved
      // user/org is request-specific in that case.
      if (!impersonate) {
        const cached = getFromAuthCache(`${payload.id}|${orgHeaderString}`);
        if (cached) {
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          req.user = cached.user;

          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          req.org = cached.org;

          setSentryUserContext({
            userId: cached.user.id,
            email: cached.user.email,
            orgId: cached.org.id,
            paymentId: cached.org.paymentId,
          });
          next();
          return;
        }
      }

      let user = (await this._userService.getUserById(
        payload.id
      )) as User | null;

      if (!user) {
        throw new HttpForbiddenException();
      }

      if (!user.activated) {
        throw new HttpForbiddenException();
      }

      if (user?.isSuperAdmin && impersonate) {
        const loadImpersonate = await this._organizationService.getUserOrg(
          impersonate
        );

        if (loadImpersonate) {
          user = loadImpersonate.user;
          user.isSuperAdmin = true;
          delete user.password;

          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          req.user = user;

          // @ts-ignore
          loadImpersonate.organization.users =
            loadImpersonate.organization.users.filter(
              (f) => f.userId === user.id
            );
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-expect-error
          req.org = loadImpersonate.organization;

          setSentryUserContext({
            userId: user.id,
            email: user.email,
            orgId: loadImpersonate.organization.id,
            paymentId: loadImpersonate.organization.paymentId,
          });
          next();
          return;
        }
      }

      delete user.password;
      const organization = (
        await this._organizationService.getOrgsByUserId(user.id)
      ).filter((f) => !f.users[0].disabled);
      const setOrg =
        organization.find((org) => org.id === orgHeader) ||
        organization.find((org) => org.subscription) ||
        organization[0];

      if (!organization) {
        throw new HttpForbiddenException();
      }

      if (!setOrg.apiKey) {
        await this._organizationService.updateApiKey(setOrg.id);
      } else if (!impersonate) {
        // `user` has already had its password stripped at this point, and
        // `setOrg` is exactly the row a fresh request would have resolved.
        // Orgs without an apiKey skip the cache so the generate-on-demand
        // path stays verified against the database every request.
        setToAuthCache(`${user.id}|${orgHeaderString}`, {
          user,
          org: setOrg,
        });
      }

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      req.user = user;

      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error
      req.org = setOrg;

      setSentryUserContext({
        userId: user.id,
        email: user.email,
        orgId: setOrg.id,
        paymentId: setOrg.paymentId,
      });
    } catch (err) {
      throw new HttpForbiddenException();
    }
    next();
  }
}
