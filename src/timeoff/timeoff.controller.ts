import { Body, Controller, Post } from '@nestjs/common';
import { TimeoffService } from './timeoff.service';
import { RequestTimeoffDto } from './dto/request-timeoff.dto';

@Controller()
export class TimeoffController {
  constructor(private readonly timeoffService: TimeoffService) {}

  @Post('timeoff/request')
  requestTimeOff(@Body() body: RequestTimeoffDto) {
    return this.timeoffService.requestTimeOff(body);
  }

  @Post('webhooks/hcm/balance-update')
  hcmBalanceUpdate(@Body() body: any) {
    return this.timeoffService.hcmBalanceUpdate(body);
  }

  @Post('webhooks/hcm/batch-sync')
hcmBatchSync(@Body() body: any) {
  return this.timeoffService.hcmBatchSync(body);
}
}

