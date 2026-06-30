import 'dotenv/config';
import { EntityManager } from 'typeorm';
import { User } from './entities/user.entity';
export interface SemanticSearchResult {
    id: number;
    conversation_id: number;
    role: string;
    content: string;
    created_at: Date;
    similarity: number;
}
export declare class ConversationsService {
    private readonly em;
    private embeddings;
    constructor(em: EntityManager);
    findConversationsByUserId(userId: number): Promise<User>;
    findMessagesByConversationId(conversationId: number): Promise<{
        id: number;
        userId: number;
        title: string | null;
        createdAt: Date;
        messages: {
            id: number;
            conversationId: number;
            role: import("./entities/message.entity").MessageRole;
            content: string;
            createdAt: Date;
        }[];
    }>;
    searchSimilarMessages(conversationId: number, searchText: string, limit?: number): Promise<SemanticSearchResult[]>;
    private getEmbeddings;
    private embedQuery;
}
