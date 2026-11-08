import { IsDefined, IsString, MinLength } from 'class-validator';

export class TwoFactorCodeDto {
  @IsString()
  @IsDefined()
  @MinLength(6)
  code: string;
}
