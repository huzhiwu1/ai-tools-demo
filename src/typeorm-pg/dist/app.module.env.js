"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModuleEnv = void 0;
require("dotenv/config");
const common_1 = require("@nestjs/common");
const app_controller_1 = require("./app.controller");
const app_service_1 = require("./app.service");
const typeorm_1 = require("@nestjs/typeorm");
const conversations_module_1 = require("./conversations/conversations.module");
const user_entity_1 = require("./conversations/entities/user.entity");
const conversation_entity_1 = require("./conversations/entities/conversation.entity");
const message_entity_1 = require("./conversations/entities/message.entity");
let AppModuleEnv = class AppModuleEnv {
};
exports.AppModuleEnv = AppModuleEnv;
exports.AppModuleEnv = AppModuleEnv = __decorate([
    (0, common_1.Module)({
        imports: [
            typeorm_1.TypeOrmModule.forRoot({
                type: 'postgres',
                host: process.env.DB_HOST || 'localhost',
                port: Number(process.env.DB_PORT) || 5432,
                username: process.env.DB_USERNAME || 'user',
                password: process.env.DB_PASSWORD || '123456',
                database: process.env.DB_DATABASE || 'hello_pg',
                synchronize: true,
                logging: true,
                entities: [user_entity_1.User, conversation_entity_1.Conversation, message_entity_1.Message],
            }),
            conversations_module_1.ConversationsModule,
        ],
        controllers: [app_controller_1.AppController],
        providers: [app_service_1.AppService],
    })
], AppModuleEnv);
//# sourceMappingURL=app.module.env.js.map