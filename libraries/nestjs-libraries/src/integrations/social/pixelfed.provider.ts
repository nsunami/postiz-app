import {
  ClientInformation,
  PostDetails,
  PostResponse,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { MastodonProvider } from '@gitroom/nestjs-libraries/integrations/social/mastodon.provider';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { AuthService } from '@gitroom/helpers/auth/auth.service';
import { getSsrfSafeDispatcher } from '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher';
import {
  BadBody,
  ValidityMedia,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { Integration } from '@prisma/client';
import { lookup } from 'mime-types';
import dayjs from 'dayjs';

// Pixelfed is federated: every account lives on its own instance, and OAuth
// client credentials belong to that instance. Users therefore type their
// instance URL when connecting; it is stored (encrypted, together with the
// client credentials) in Integration.customInstanceDetails.
const normalizeInstanceUrl = (value?: string) => {
  const trimmed = (value || '').trim();
  if (!trimmed) {
    throw new Error('Pixelfed instance URL is missing');
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) {
    throw new Error('Invalid Pixelfed instance URL');
  }

  const parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Invalid Pixelfed instance URL');
  }

  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, '')}`;
};

export class PixelfedProvider extends MastodonProvider {
  override maxConcurrentJob = 5; // Pixelfed instances typically have generous limits
  override identifier = 'pixelfed';
  override name = 'Pixelfed';
  override scopes = ['read', 'write'];
  toolTip =
    'Enter your Pixelfed instance URL, for example https://pixelfed.social';

  maxLength() {
    return 2000;
  }

  override async checkValidity([firstPost]: Array<
    ValidityMedia[]
  >): Promise<string | true> {
    if (!firstPost?.length) {
      return 'Pixelfed requires at least one photo or video';
    }

    if (firstPost.some((media) => (media?.alt?.length ?? 0) > 1000)) {
      return 'Pixelfed alt text can be up to 1000 characters';
    }

    return true;
  }

  override handleErrors(
    body: string,
    status: number
  ):
    | { type: 'refresh-token' | 'bad-body' | 'retry'; value: string }
    | undefined {
    if (status === 422 && /(file|media|image|video|upload)/i.test(body)) {
      return {
        type: 'bad-body',
        value:
          'Pixelfed rejected the media file, please check the file type and size allowed by this instance',
      };
    }

    if (status === 422 && /(alt text|description)/i.test(body)) {
      return {
        type: 'bad-body',
        value: 'This Pixelfed instance requires alt text for every media item',
      };
    }

    return super.handleErrors(body, status);
  }

  // Registers a Postiz OAuth app on the user's instance. Called once when the
  // user submits the instance URL; the credentials are then encrypted into the
  // integration so reconnects can reuse them.
  async externalUrl(url: string) {
    const instance = normalizeInstanceUrl(url);

    const response = await fetch(`${instance}/api/v1/apps`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_name: 'Postiz',
        redirect_uris: `${process.env.FRONTEND_URL}/integrations/social/pixelfed`,
        scopes: this.scopes.join(' '),
        website: process.env.FRONTEND_URL,
      }),
      signal: AbortSignal.timeout(15_000),
      // @ts-ignore - undici-only option; blocks SSRF to internal IPs
      dispatcher: getSsrfSafeDispatcher(),
    });

    if (!response.ok) {
      throw new Error('Could not register with that Pixelfed instance');
    }

    const { client_id, client_secret } = await response.json();
    if (!client_id || !client_secret) {
      throw new Error('Could not register with that Pixelfed instance');
    }

    return {
      client_id: String(client_id),
      client_secret: String(client_secret),
    };
  }

  override async generateAuthUrl(clientInformation?: ClientInformation) {
    const instance = normalizeInstanceUrl(clientInformation?.instanceUrl);
    const state = makeSecureId(6);

    const url = `${instance}/oauth/authorize?client_id=${encodeURIComponent(
      clientInformation!.client_id
    )}&response_type=code&redirect_uri=${encodeURIComponent(
      `${process.env.FRONTEND_URL}/integrations/social/pixelfed`
    )}&scope=${encodeURIComponent(
      this.scopes.join(' ')
    )}&state=${state}`;

    return {
      url,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  override async authenticate(
    params: {
      code: string;
      codeVerifier: string;
      refresh?: string;
    },
    clientInformation?: ClientInformation
  ) {
    const instance = normalizeInstanceUrl(clientInformation?.instanceUrl);

    const tokenInformation = await (
      await this.fetch(
        `${instance}/oauth/token`,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            grant_type: 'authorization_code',
            code: params.code,
            client_id: clientInformation!.client_id,
            client_secret: clientInformation!.client_secret,
            redirect_uri: `${process.env.FRONTEND_URL}/integrations/social/pixelfed`,
          }),
        },
        this.identifier
      )
    ).json();

    if (!tokenInformation?.access_token) {
      throw new Error('Could not authenticate with Pixelfed');
    }

    const personalInformation = await (
      await this.fetch(
        `${instance}/api/v1/accounts/verify_credentials`,
        {
          headers: {
            Authorization: `Bearer ${tokenInformation.access_token}`,
          },
        },
        this.identifier
      )
    ).json();

    if (!personalInformation?.id) {
      throw new Error('Could not authenticate with Pixelfed');
    }

    return {
      id: String(personalInformation.id),
      name:
        personalInformation.display_name ||
        personalInformation.acct ||
        personalInformation.username ||
        '',
      accessToken: tokenInformation.access_token,
      refreshToken: tokenInformation.refresh_token || 'null',
      expiresIn:
        Number(tokenInformation.expires_in) ||
        dayjs().add(100, 'years').unix() - dayjs().unix(),
      picture: personalInformation?.avatar || '',
      username: personalInformation.username,
    };
  }

  // Media can live on local storage (absolute path) or on an object store
  // (http url); readOrFetch handles both and applies the SSRF-safe client to
  // remote urls. A buffered body keeps this.fetch's retry working, unlike a
  // consumed multipart stream.
  override async uploadFile(
    instanceUrl: string,
    fileUrl: string,
    accessToken: string,
    alt?: string
  ) {
    const buffer = await this.readOrFetch(fileUrl);
    const filename = fileUrl.split('?')[0].split('/').pop() || 'file';

    const form = new FormData();
    form.append(
      'file',
      new Blob([buffer], {
        type: lookup(filename) || 'application/octet-stream',
      }),
      filename
    );
    if (alt) {
      form.append('description', alt);
    }

    const media = await (
      await this.fetch(
        `${instanceUrl}/api/v1/media`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          body: form,
        },
        this.identifier
      )
    ).json();

    if (!media?.id) {
      throw new BadBody(
        this.identifier,
        JSON.stringify(media),
        '{}',
        'Pixelfed did not return a media id'
      );
    }

    return media.id;
  }

  // Pixelfed's canonical status urls are /p/{username}/{id}; the status
  // response already carries the right one.
  protected override statusUrl(url: string, status: any) {
    return status.url || `${url}/statuses/${status.id}`;
  }

  // The user's instance URL and OAuth client, saved encrypted at connection
  // time.
  private instanceUrl(integration?: Integration) {
    try {
      const { instanceUrl } = JSON.parse(
        AuthService.fixedDecryption(integration?.customInstanceDetails || '')
      );
      return normalizeInstanceUrl(instanceUrl);
    } catch (err) {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'The Pixelfed instance information is missing, please reconnect the channel'
      );
    }
  }

  override async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return this.dynamicPost(
      id,
      accessToken,
      this.instanceUrl(integration),
      postDetails
    );
  }

  override async postPending(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return this.dynamicPostPending(
      id,
      accessToken,
      this.instanceUrl(integration),
      postDetails
    );
  }

  override async comment(
    id: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    return this.dynamicComment(
      id,
      postId,
      lastCommentId,
      accessToken,
      this.instanceUrl(integration),
      postDetails
    );
  }
}
