import { BadRequestException, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AuthProviderAbstract } from '@gitroom/backend/services/auth/providers.interface';

@Injectable()
export class AuthProviderManager {
  constructor(private _moduleRef: ModuleRef) {}

  getProvider(provider: string): AuthProviderAbstract {
    const metadata =
      Reflect.getMetadata('auth-provider', AuthProviderAbstract) || [];

    const found = metadata.find(
      (m: any) => m.provider === provider
    );

    if (!found) {
      throw new BadRequestException('Sign-in method is not available');
    }

    return this._moduleRef.get(found.target, { strict: false });
  }
}
