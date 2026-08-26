import { CashInOperationStatus } from '../schemas/cash-in-operation.schema';

export class CashInResponseDto {
  operation_id: string;
  status: CashInOperationStatus;
  amount: number;
  new_balance: number;
}
