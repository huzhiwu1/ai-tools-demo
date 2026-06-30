import { ConversationsService } from './conversations.service';
import { SemanticSearchDto } from './dto/semantic-search.dto';
export declare class ConversationsController {
    private readonly conversationsService;
    constructor(conversationsService: ConversationsService);
    findByUser(userId: number): Promise<import("./entities/user.entity").User>;
    findMessages(id: number): Promise<{
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
    search(id: number, dto: SemanticSearchDto, queryLimit?: number): Promise<import("./conversations.service").SemanticSearchResult[]>;
}
