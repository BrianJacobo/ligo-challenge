import { IsIn, IsISO8601, IsOptional, IsString } from 'class-validator';

export class PaymentWebhookDto {
  @IsString()
  operation_id: string;

  @IsOptional()
  @IsString()
  provider_reference?: string;

  @IsIn(['success', 'failed'])
  status: 'success' | 'failed';

  @IsISO8601()
  timestamp: string;
}
