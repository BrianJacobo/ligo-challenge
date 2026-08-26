import { IsNumber, IsPositive, IsString } from 'class-validator';

export class CreateCashInDto {
  @IsString()
  user_id: string;

  @IsNumber()
  @IsPositive()
  amount: number;

  @IsString()
  currency: string;

  @IsString()
  payment_method: string;
}
