import { MessageRole } from '../entities/message.entity';
export declare class CreateMessageDto {
    conversationId: number;
    role: MessageRole;
    content: string;
}
