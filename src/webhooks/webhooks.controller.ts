import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';
import { PaymentWebhookDto } from './dto/payment-webhook.dto';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post('payment')
  @HttpCode(HttpStatus.OK)
  handlePayment(@Body() dto: PaymentWebhookDto) {
    return this.webhooksService.handlePaymentWebhook(dto);
  }
}
