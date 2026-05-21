import {
  ConflictException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class TimeoffService {
  constructor(private prisma: PrismaService) {}

  async requestTimeOff(body: {
    employeeId: string;
    locationId: string;
    daysRequested: number;
    idempotencyKey?: string;
  }) {
    const { employeeId, locationId, daysRequested, idempotencyKey } = body;

    if (idempotencyKey) {
      const existing = await this.prisma.timeOffRequest.findUnique({
        where: { idempotencyKey },
      });

      if (existing) {
        return existing;
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const balance = await tx.balance.findUnique({
        where: {
          employeeId_locationId: {
            employeeId,
            locationId,
          },
        },
      });

      if (!balance) {
        throw new UnprocessableEntityException('No balance found');
      }

      if (balance.balance < daysRequested) {
        throw new UnprocessableEntityException('Insufficient balance');
      }

      const updated = await tx.balance.updateMany({
        where: {
          employeeId,
          locationId,
          version: balance.version,
          balance: {
            gte: daysRequested,
          },
        },
        data: {
          balance: {
            decrement: daysRequested,
          },
          version: {
            increment: 1,
          },
        },
      });

      if (updated.count !== 1) {
        throw new ConflictException('Concurrent balance update detected');
      }

      const request = await tx.timeOffRequest.create({
        data: {
          employeeId,
          locationId,
          daysRequested,
          status: 'APPROVED',
          idempotencyKey,
        },
      });

      await tx.balanceLedger.create({
        data: {
          employeeId,
          locationId,
          delta: -daysRequested,
          eventType: 'TIME_OFF_REQUEST',
          requestId: request.id,
        },
      });

      const hcmResponse = await this.mockHcmFileTimeOff({
  employeeId,
  locationId,
  daysRequested,
});

if (!hcmResponse.accepted) {
  await tx.timeOffRequest.update({
    where: { id: request.id },
    data: { status: 'FAILED_SYNC' },
  });

  await tx.balance.update({
    where: {
      employeeId_locationId: {
        employeeId,
        locationId,
      },
    },
    data: {
      balance: { increment: daysRequested },
      version: { increment: 1 },
    },
  });

  await tx.balanceLedger.create({
    data: {
      employeeId,
      locationId,
      delta: daysRequested,
      eventType: 'HCM_REJECTION_ROLLBACK',
      requestId: request.id,
    },
  });

  return {
    ...request,
    status: 'FAILED_SYNC',
    hcmResponse,
  };
}

return {
  ...request,
  hcmReferenceId: hcmResponse.hcmReferenceId,
  hcmResponse,
};

    });
  }

  async hcmBalanceUpdate(body: {
    employeeId: string;
    locationId: string;
    balance: number;
  }) {
    const { employeeId, locationId, balance } = body;

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.balance.findUnique({
        where: {
          employeeId_locationId: {
            employeeId,
            locationId,
          },
        },
      });

      const previousBalance = current?.balance ?? 0;
      const delta = balance - previousBalance;

      const updated = await tx.balance.upsert({
        where: {
          employeeId_locationId: {
            employeeId,
            locationId,
          },
        },
        update: {
          balance,
          version: {
            increment: 1,
          },
          lastSyncedAt: new Date(),
        },
        create: {
          employeeId,
          locationId,
          balance,
        },
      });

      await tx.balanceLedger.create({
        data: {
          employeeId,
          locationId,
          delta,
          eventType: 'HCM_RECONCILIATION',
        },
      });

      return updated;
    });
  }

  async hcmBatchSync(body: {
  balances: { employeeId: string; locationId: string; balance: number }[];
}) {
  const results = [];

  for (const item of body.balances) {
    results.push(await this.hcmBalanceUpdate(item));
  }

  return { synced: results.length, results };
}



private async mockHcmFileTimeOff(body: {
  employeeId: string;
  locationId: string;
  daysRequested: number;
}) {
  if (body.employeeId === 'hcm-fail') {
    return {
      accepted: false,
      reason: 'HCM_REJECTED_INVALID_DIMENSIONS',
    };
  }

  return {
    accepted: true,
    hcmReferenceId: `hcm-${Date.now()}`,
  };
}

}

