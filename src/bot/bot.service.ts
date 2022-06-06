import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import * as TelegramBot from 'node-telegram-bot-api';
import { Report, ReportDocument, PauseModel } from './schemas/report.schema';
@Injectable()
export class BotService {
  private _bot: TelegramBot;
  private _token: string;

  constructor(
    @InjectModel(User.name) private _userModel: Model<UserDocument>,
    @InjectModel(Report.name) private _reportModel: Model<ReportDocument>,
  ) {}

  onModuleInit() {
    this._token = this._getToken();
    this._bot = new TelegramBot(this._token, { polling: true });
    this._bot.setMyCommands([
      { command: 'start', description: 'Start the bot' },
      { command: 'report', description: 'Start new report' },
      { command: 'add', description: 'Add new report' },
      { command: 'list', description: 'Get list reports' },
      { command: 'month', description: 'Get month report' },
    ]);
    console.log('Telegram Bot started');
    this._onCallbackQuery();
    this._resetTextListeners();
  }

  private _getToken(): string {
    return process.env.BOT_TOKEN;
  }

  private async _resetTextListeners() {
    await this._bot.clearTextListeners();
    this._onStart();
    this._onReport();
  }

  private _onStart() {
    this._bot.onText(/\/start/, async (msg, match) => {
      const chatId = msg.chat.id;
      const candidate = await this._userModel.find({ chatId: chatId });
      if (candidate.length === 0) {
        const createUser = new this._userModel({
          chatId: chatId,
          firstName: msg.from.first_name ? msg.from.first_name : '',
          lastName: msg.from.last_name ? msg.from.last_name : '',
          username: msg.from.username,
          date: new Date(),
        });
        await createUser.save();
        this._bot.sendMessage(chatId, 'Hello ' + msg.from.first_name);
      } else {
        console.log('user is exist');
      }
    });
  }

  private async _onCallbackQuery() {
    this._bot.on('callback_query', async (callbackQuery) => {
      const reportCandidate = await this._getReportNoCompleted();
      if (!!reportCandidate) {
        switch (callbackQuery?.data) {
          case 'report_get_time':
            if (reportCandidate.messageId == callbackQuery.message.message_id) {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Hola');
            } else {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Not Valid');
            }
            break;
          case 'report_pause_start':
            if (reportCandidate.messageId == callbackQuery.message.message_id) {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Hola');
              console.log(callbackQuery);
              await this._startPause(reportCandidate._id);
              await this._sendReport(
                callbackQuery.message.chat.id,
                reportCandidate._id,
                'pause',
              );
              await this._bot.deleteMessage(
                callbackQuery.message.chat.id,
                callbackQuery.message.message_id,
              );
            } else {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Not Valid');
            }
            break;
          case 'report_pause':
            if (reportCandidate.messageId == callbackQuery.message.message_id) {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Hola');
              await this._sendReport(
                callbackQuery.message.chat.id,
                reportCandidate._id,
                'start',
              );
              await this._bot.deleteMessage(
                callbackQuery.message.chat.id,
                callbackQuery.message.message_id,
              );
              await this._stopPause(reportCandidate._id);
            } else {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Not Valid');
            }
            break;
          case 'report_stop':
            if (reportCandidate.messageId == callbackQuery.message.message_id) {
              await this._reportComplete(reportCandidate._id);
              await this._bot.deleteMessage(
                callbackQuery.message.chat.id,
                callbackQuery.message.message_id,
              );
              // await this._bot.sendMessage(
              //   callbackQuery.message.chat.id,
              //   'Success white report ti start',
              // );
              this._bot.answerCallbackQuery(
                callbackQuery?.id,
                'Success white /report ti start',
              );
            } else {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Not Valid');
            }
            break;
        }
      }
    });
  }

  private _onReport() {
    this._bot.onText(/\/report/, async (msg, match) => {
      const chatId = msg.chat.id;
      const candidate = await this._userModel.findOne({ chatId: chatId });
      const reportCandidate = await this._getReportNoCompleted();
      if (!!candidate) {
        if (!!reportCandidate) {
          await this._sendReport(
            chatId,
            reportCandidate._id,
            !!reportCandidate.pauseOn ? 'stop' : 'start',
          );
        } else {
          console.log('create');
          await this._createReport(chatId, candidate._id);
        }
      }
    });
  }

  private async _getReportNoCompleted() {
    const result = await this._reportModel.findOne({
      completed: false,
    });
    return result;
  }

  private async _startPause(reportId) {
    const result = await this._reportModel.findByIdAndUpdate(reportId);
    result.pauseOn = true;
    result.pause.push({
      pauseStart: new Date(),
      pauseEnd: new Date('0000-00-00T00:00:00.000+00:00'),
    });
    await result.save();
  }

  private async _stopPause(reportId) {
    const result = await this._reportModel.findByIdAndUpdate(reportId);
    result.pauseOn = false;
    result.pause[result.pause.length - 1] = {
      pauseStart: result.pause[result.pause.length - 1].pauseStart,
      pauseEnd: new Date(),
    };
    await result.save();
    console.log();
  }

  private async _sendReport(chatId, reportId, mode = 'start') {
    const result = await this._reportModel.findByIdAndUpdate(reportId);
    const message = await this._bot.sendMessage(
      chatId,
      'Title: ' + result.title + ' id: ' + result._id,
      this._getInlineKeyboard(mode, reportId),
    );
    const setMessageId = await this._reportModel.findByIdAndUpdate(reportId, {
      messageId: message.message_id,
    });
    await setMessageId.save();
  }

  private async _createReport(chatId, userId) {
    console.log(chatId);
    await this._bot.sendMessage(chatId, 'Escribe nonbre de la predi');
    this._bot.onText(/./, async (msg, match) => {
      const result = new this._reportModel({
        userId: userId,
        title: msg.text,
        dateStart: new Date(),
      });
      await result.save();
      await this._sendReport(chatId, result._id);
      await this._resetTextListeners();
    });
  }

  private _getInlineKeyboard(mode, reportId) {
    return {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '⏱️',
              callback_data: 'report_get_time',
            },
            {
              text: mode === 'start' ? '⏸️' : '▶️',
              callback_data:
                mode === 'start' ? 'report_pause_start' : 'report_pause',
            },
            {
              text: '⏹️',
              callback_data: 'report_stop',
            },
          ],
        ],
      },
    };
  }

  private async _reportComplete(reportId) {
    const result = await this._reportModel.findByIdAndUpdate(reportId, {
      completed: true,
      dateEnd: new Date(),
    });
    await result.save();
  }
}
