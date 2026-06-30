import { User } from './user.entity';
import { Message } from './message.entity';
export declare class Conversation {
    id: number;
    userId: number;
    title: string | null;
    createdAt: Date;
    user: User;
    messages: Message[];
}
