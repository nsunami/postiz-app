import { HttpException, Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { UsersService } from '@gitroom/nestjs-libraries/database/prisma/users/users.service';
import { randomBytes } from 'crypto';
import dayjs from 'dayjs';
import * as QRCode from 'qrcode';

const TWO_FACTOR_ISSUER = 'Postiz';
const RECOVERY_CODES_COUNT = 10;
const MAX_VERIFY_ATTEMPTS = 5;
const VERIFY_WINDOW_MINUTES = 5;

@Injectable()
export class TwoFactorService {
  constructor(private _userService: UsersService) {}

  private normalizeRecoveryCode(code: string) {
    return code.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  private generateRecoveryCodes() {
    return Array.from({ length: RECOVERY_CODES_COUNT }, () =>
      randomBytes(5)
        .toString('hex')
        .replace(/(.{5})(.{5})/, '$1-$2')
    );
  }

  private hashRecoveryCodes(recoveryCodes: string[]) {
    return recoveryCodes.map((code) =>
      AuthService.hashPassword(this.normalizeRecoveryCode(code))
    );
  }

  private attemptsWindowStart(row: {
    attempts: number;
    windowStart: Date | null;
  }) {
    const active =
      !!row.windowStart &&
      dayjs().diff(dayjs(row.windowStart), 'minute') < VERIFY_WINDOW_MINUTES;

    return {
      attempts: active ? row.attempts : 0,
      windowStart: active ? row.windowStart : new Date(),
    };
  }

  async isEnabled(userId: string) {
    const twoFactor = await this._userService.getUserTwoFactor(userId);
    return !!twoFactor?.enabled;
  }

  async status(userId: string) {
    return { enabled: await this.isEnabled(userId) };
  }

  async setup(userId: string, email: string) {
    const user = await this._userService.getUserById(userId);
    if (!user || user.providerName !== Provider.LOCAL) {
      throw new HttpException(
        'Two-factor authentication is only available for email and password accounts',
        400
      );
    }

    const existing = await this._userService.getUserTwoFactor(userId);
    if (existing?.enabled) {
      throw new HttpException(
        'Two-factor authentication is already enabled',
        400
      );
    }

    const secret = AuthService.generateTotpSecret();
    await this._userService.upsertUserTwoFactorSecret(
      userId,
      AuthService.encryptSecret(secret)
    );

    const uri = AuthService.totpUri(secret, email, TWO_FACTOR_ISSUER);

    return {
      secret,
      uri,
      qr: await QRCode.toDataURL(uri, { margin: 1, width: 240 }),
    };
  }

  async enable(userId: string, code: string) {
    const existing = await this._userService.getUserTwoFactor(userId);
    if (!existing || existing.enabled) {
      throw new HttpException('Two-factor setup has not started', 400);
    }

    const step = AuthService.verifyTotp(
      AuthService.decryptSecret(existing.secret),
      code.trim()
    );

    if (!step) {
      throw new HttpException('Invalid authentication code', 400);
    }

    const recoveryCodes = this.generateRecoveryCodes();
    await this._userService.enableUserTwoFactor(
      userId,
      this.hashRecoveryCodes(recoveryCodes),
      step
    );

    return { recoveryCodes };
  }

  async disable(userId: string, password?: string, code?: string) {
    const existing = await this._userService.getUserTwoFactor(userId);
    if (!existing?.enabled) {
      throw new HttpException('Two-factor authentication is not enabled', 400);
    }

    if (password) {
      const user = await this._userService.getUserById(userId);
      if (
        !user?.password ||
        !AuthService.comparePassword(password, user.password)
      ) {
        throw new HttpException('Invalid password', 400);
      }
    } else {
      await this.verify(userId, code || '');
    }

    await this._userService.disableUserTwoFactor(userId);
    return { enabled: false };
  }

  async regenerateRecoveryCodes(userId: string, code: string) {
    const existing = await this._userService.getUserTwoFactor(userId);
    if (!existing?.enabled) {
      throw new HttpException('Two-factor authentication is not enabled', 400);
    }

    const step = AuthService.verifyTotp(
      AuthService.decryptSecret(existing.secret),
      code.trim()
    );

    if (!step) {
      throw new HttpException('Invalid authentication code', 400);
    }

    const recoveryCodes = this.generateRecoveryCodes();
    await this._userService.updateUserTwoFactorRecoveryCodes(
      userId,
      this.hashRecoveryCodes(recoveryCodes),
      step
    );

    return { recoveryCodes };
  }

  /**
   * Validates a login code (TOTP or a one-time recovery code). Throws when the
   * code is rejected so callers can never continue with a partial result.
   */
  async verify(userId: string, code: string) {
    const existing = await this._userService.getUserTwoFactor(userId);
    if (!existing?.enabled) {
      throw new HttpException('Two-factor authentication is not enabled', 400);
    }

    const { attempts, windowStart } = this.attemptsWindowStart(existing);
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      throw new HttpException('Too many attempts, please try again later', 429);
    }

    const fail = async () => {
      await this._userService.updateUserTwoFactorAttempts(
        userId,
        attempts + 1,
        windowStart
      );
      throw new HttpException('Invalid authentication code', 400);
    };

    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) {
      const step = AuthService.verifyTotp(
        AuthService.decryptSecret(existing.secret),
        trimmed
      );

      // Older or already used steps are rejected to stop code replay.
      if (!step || step <= existing.lastUsedStep) {
        return fail();
      }

      await this._userService.updateUserTwoFactorStep(userId, step);
      return true;
    }

    const normalized = this.normalizeRecoveryCode(trimmed);
    const matchingIndex = existing.recoveryCodes.findIndex((hash) =>
      AuthService.comparePassword(normalized, hash)
    );

    if (matchingIndex === -1) {
      return fail();
    }

    await this._userService.useUserTwoFactorRecoveryCode(
      userId,
      existing.recoveryCodes.filter((_, index) => index !== matchingIndex)
    );
    return true;
  }
}
