import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  CashInOperation,
  CashInOperationDocument,
  CashInOperationStatus,
} from './schemas/cash-in-operation.schema';

export interface InsertPendingInput {
  operationId: string;
  idempotencyKey: string;
  userId: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  requestHash: string;
}

/** Thrown when the unique index on `idempotencyKey` rejects a concurrent insert. */
export class DuplicateIdempotencyKeyError extends Error {
  constructor(idempotencyKey: string) {
    super(`Operation with idempotencyKey "${idempotencyKey}" already exists`);
    this.name = 'DuplicateIdempotencyKeyError';
  }
}

const MONGO_DUPLICATE_KEY_ERROR_CODE = 11000;

@Injectable()
export class CashInOperationRepository {
  constructor(
    @InjectModel(CashInOperation.name)
    private readonly model: Model<CashInOperationDocument>,
  ) {}

  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<CashInOperationDocument | null> {
    return this.model.findOne({ idempotencyKey }).exec();
  }

  findByOperationId(
    operationId: string,
  ): Promise<CashInOperationDocument | null> {
    return this.model.findOne({ operationId }).exec();
  }

  async insertPending(
    input: InsertPendingInput,
  ): Promise<CashInOperationDocument> {
    try {
      return await this.model.create({
        ...input,
        status: 'pending',
        providerReference: null,
      });
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new DuplicateIdempotencyKeyError(input.idempotencyKey);
      }
      throw error;
    }
  }

  /**
   * Transitions the operation out of "pending" atomically. If it no longer matches
   * "pending" (already completed/failed by a concurrent request or a duplicate/
   * out-of-order webhook), this is a no-op and returns null — callers must treat
   * that as "already resolved", never as an error.
   */
  updateStatusIfPending(
    operationId: string,
    newStatus: Exclude<CashInOperationStatus, 'pending'>,
    providerReference: string | null,
  ): Promise<CashInOperationDocument | null> {
    return this.model
      .findOneAndUpdate(
        { operationId, status: 'pending' },
        { $set: { status: newStatus, providerReference } },
        { returnDocument: 'after' },
      )
      .exec();
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: number }).code === MONGO_DUPLICATE_KEY_ERROR_CODE
    );
  }
}
