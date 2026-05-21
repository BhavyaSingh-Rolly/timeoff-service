import { IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class RequestTimeoffDto {
  @IsString()
  employeeId: string;

  @IsString()
  locationId: string;

  @IsNumber()
  @Min(0.01)
  daysRequested: number;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}