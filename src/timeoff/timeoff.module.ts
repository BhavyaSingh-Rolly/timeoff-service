import { Module } from '@nestjs/common';
import { TimeoffService } from './timeoff.service';
import { TimeoffController } from './timeoff.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [TimeoffController],
  providers: [TimeoffService],
})
export class TimeoffModule {}