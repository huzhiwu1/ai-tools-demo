import { Conversation } from './conversation.entity';
export declare class User {
    id: number;
    name: string;
    createdAt: Date;
    conversations: Conversation[];
}
