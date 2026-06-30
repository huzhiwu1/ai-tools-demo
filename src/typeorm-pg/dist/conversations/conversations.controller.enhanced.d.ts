import { ConversationsServiceEnhanced } from './conversations.service.enhanced';
import { SemanticSearchDto } from './dto/semantic-search.dto';
import { CreateMessageDto } from './dto/create-message.dto';
export declare class ConversationsControllerEnhanced {
    private readonly conversationsService;
    constructor(conversationsService: ConversationsServiceEnhanced);
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
    createMessage(dto: CreateMessageDto): Promise<import("./entities/message.entity").Message>;
    search(id: number, dto: SemanticSearchDto, queryLimit?: number): Promise<import("./conversations.service.enhanced").SemanticSearchResult[]>;
}
