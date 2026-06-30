"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConversationsService = void 0;
require("dotenv/config");
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const openai_1 = require("@langchain/openai");
const typeorm_2 = require("typeorm");
const user_entity_1 = require("./entities/user.entity");
const conversation_entity_1 = require("./entities/conversation.entity");
let ConversationsService = class ConversationsService {
    em;
    embeddings = null;
    constructor(em) {
        this.em = em;
    }
    async findConversationsByUserId(userId) {
        const user = await this.em.findOne(user_entity_1.User, {
            where: { id: userId },
            relations: { conversations: true },
            order: { conversations: { createdAt: 'DESC' } },
        });
        if (!user) {
            throw new common_1.NotFoundException(`User #${userId} not found`);
        }
        return user;
    }
    async findMessagesByConversationId(conversationId) {
        const conversation = await this.em.findOne(conversation_entity_1.Conversation, {
            where: { id: conversationId },
            relations: { messages: true },
            order: { messages: { createdAt: 'ASC' } },
        });
        if (!conversation) {
            throw new common_1.NotFoundException(`Conversation #${conversationId} not found`);
        }
        return {
            id: conversation.id,
            userId: conversation.userId,
            title: conversation.title,
            createdAt: conversation.createdAt,
            messages: conversation.messages.map(({ id, conversationId, role, content, createdAt }) => ({
                id,
                conversationId,
                role,
                content,
                createdAt,
            })),
        };
    }
    async searchSimilarMessages(conversationId, searchText, limit = 5) {
        const conversation = await this.em.findOne(conversation_entity_1.Conversation, {
            where: { id: conversationId },
        });
        if (!conversation) {
            throw new common_1.NotFoundException(`Conversation #${conversationId} not found`);
        }
        const vector = await this.embedQuery(searchText);
        const rows = await this.em.query(`SELECT id, conversation_id, role, content, created_at,
              1 - (embedding <=> $1::vector) AS similarity
       FROM messages
       WHERE conversation_id = $2 AND embedding IS NOT NULL
       ORDER BY embedding <=> $1::vector
       LIMIT $3`, [JSON.stringify(vector), conversationId, limit]);
        return rows.map((row) => ({
            ...row,
            similarity: Number(row.similarity),
        }));
    }
    getEmbeddings() {
        if (!this.embeddings) {
            if (!process.env.OPENAI_API_KEY) {
                throw new common_1.BadRequestException('语义检索需要配置 OPENAI_API_KEY（与 pgsql-test 相同）');
            }
            this.embeddings = new openai_1.OpenAIEmbeddings({
                model: process.env.EMBEDDING_MODEL || 'text-embedding-v3',
                apiKey: process.env.OPENAI_API_KEY,
                configuration: {
                    baseURL: process.env.OPENAI_BASE_URL,
                },
            });
        }
        return this.embeddings;
    }
    async embedQuery(text) {
        return this.getEmbeddings().embedQuery(text);
    }
};
exports.ConversationsService = ConversationsService;
exports.ConversationsService = ConversationsService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectEntityManager)()),
    __metadata("design:paramtypes", [typeorm_2.EntityManager])
], ConversationsService);
//# sourceMappingURL=conversations.service.js.map