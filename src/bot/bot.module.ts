import { HttpModule, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { BotService } from './bot.service';

import { User, UserSchema } from './schemas/user.schema';
import { Report, ReportSchema } from './schemas/report.schema';

@Module({
  providers: [BotService],
  imports: [
    HttpModule,
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Report.name, schema: ReportSchema },
    ]),
  ],
  exports: [BotService],
})
export class BotModule {}
