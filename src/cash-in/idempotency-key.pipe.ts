import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class IdempotencyKeyPipe implements PipeTransform<string | undefined, string> {
  transform(value: string | undefined): string {
    if (!value) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    if (!UUID_REGEX.test(value)) {
      throw new BadRequestException('Idempotency-Key header must be a valid UUID');
    }

    return value;
  }
}
