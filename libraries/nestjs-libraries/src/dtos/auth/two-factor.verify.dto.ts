import { IsDefined, IsString, MinLength } from 'class-validator';

export class TwoFactorVerifyDto {
  @IsString()
  @IsDefined()
  @MinLength(10)
  challenge: string;

  @IsString()
  @IsDefined()
  @MinLength(6)
  code: string;
}
