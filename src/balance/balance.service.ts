import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BalanceService {
  constructor(private prisma: PrismaService) {}

  async getBalance(employeeId: string, locationId: string) {
    return this.prisma.balance.findUnique({
      where: {
        employeeId_locationId: {
          employeeId,
          locationId,
        },
      },
    });
  }
}