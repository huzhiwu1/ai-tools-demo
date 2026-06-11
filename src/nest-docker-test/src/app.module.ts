import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BookModule } from './book/book.module';
import { Book } from './book/entities/book.entity';

// 区分开发环境和生产环境
const isProduction = process.env.NODE_ENV === 'production';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'mysql',
      // 开发环境：Node 跑在宿主机，用 localhost 连 Docker 里的 MySQL
      // 生产环境：Node 也跑在 Docker 里，用容器名连接
      host: isProduction ? 'mysql-prod' : 'localhost',
      port: 3306,
      username: 'root',
      password: 'admin',
      database: 'book',
      synchronize: true, // 自动同步表结构
      logging: true,
      entities: [Book],
    }),
    BookModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
