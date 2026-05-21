import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { BalanceModule } from './balance/balance.module';
import { TimeoffModule } from './timeoff/timeoff.module';


@Module({
  imports: [PrismaModule, BalanceModule, TimeoffModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
