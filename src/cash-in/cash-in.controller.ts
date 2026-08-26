import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Headers,
} from '@nestjs/common';
import { CashInService } from './cash-in.service';
import { CreateCashInDto } from './dto/create-cash-in.dto';
import { IdempotencyKeyPipe } from './idempotency-key.pipe';

@Controller('cash-in')
export class CashInController {
  private readonly idempotencyKeyPipe = new IdempotencyKeyPipe();

  constructor(private readonly cashInService: CashInService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  create(
    @Body() dto: CreateCashInDto,
    @Headers('idempotency-key') rawIdempotencyKey?: string,
  ) {
    const idempotencyKey = this.idempotencyKeyPipe.transform(rawIdempotencyKey);
    return this.cashInService.process(dto, idempotencyKey);
  }
}
