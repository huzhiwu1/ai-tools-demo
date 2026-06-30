import { Conversation } from './conversation.entity';
export declare enum MessageRole {
    USER = "user",
    ASSISTANT = "assistant",
    SYSTEM = "system"
}
export declare class Message {
    id: number;
    conversationId: number;
    role: MessageRole;
    content: string;
    embedding: number[] | null;
    createdAt: Date;
    conversation: Conversation;
}
