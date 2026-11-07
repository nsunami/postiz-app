import { IsOptional, IsString, MinLength } from 'class-validator';

export class TwoFactorDisableDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  password?: string;

  @IsOptional()
  @IsString()
  @MinLength(6)
  code?: string;
}
