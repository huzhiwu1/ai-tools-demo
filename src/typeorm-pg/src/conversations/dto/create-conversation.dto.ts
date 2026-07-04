import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateConversationDto {
  @IsNumber()
  userId!: number;
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}
