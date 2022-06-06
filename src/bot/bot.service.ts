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

  private _REPORT_OPTIONS_START = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'Get Time',
            callback_data: 'report_get_time',
          },
          {
            text: 'Pausa',
            callback_data: 'report_pause',
          },
          {
            text: 'Stop',
            callback_data: 'report_stop',
          },
        ],
      ],
    },
  };

  private _REPORT_OPTIONS_PAUSE = {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: 'Get Time',
            callback_data: 'report_get_time',
          },
          {
            text: 'Start',
            callback_data: 'report_pause_start',
          },
          {
            text: 'Stop',
            callback_data: 'report_stop',
          },
        ],
      ],
    },
  };

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

  private _onCallbackQuery() {
    this._bot.on('callback_query', async (callbackQuery) => {
      switch (callbackQuery?.data) {
        case 'report_get_time':
          this._bot.answerCallbackQuery(callbackQuery?.id, 'Hola');
          break;
        case 'report_pause_start':
          this._updateMessageOnReport(
            callbackQuery?.message?.chat?.id,
            callbackQuery?.message?.message_id,
            'start',
            false,
          );
          break;
        case 'report_pause':
          this._updateMessageOnReport(
            callbackQuery?.message?.chat?.id,
            callbackQuery?.message?.message_id,
            'pause',
            false,
          );
          break;
      }
    });
  }

  private _onReport() {
    this._bot.onText(/\/report/, async (msg, match) => {
      const chatId = msg.chat.id;
      const candidate = await this._userModel.findOne({ chatId: chatId });
      const reportCandidate = await this._reportModel.findOne({
        completed: false,
      });
      if (!!candidate) {
        if (!!reportCandidate) {
          const indexNotEnded = await this._reportIsNotPaused(
            reportCandidate._id,
          );
          let mode: string;
          if (indexNotEnded.length > 0) {
            mode = 'pause';
          } else {
            mode = 'start';
          }
          console.log('mode', mode);
          await this._updateMessageOnReport(
            chatId,
            reportCandidate.messageId,
            mode,
            true,
          );
        } else {
          await this._startMessageOnReport(chatId, candidate?._id);
        }
      }
    });
  }

  private async _sendMessageOnReport(chatId, title, mode) {
    return await this._bot.sendMessage(
      chatId,
      'Title: ' + title,
      mode === 'start'
        ? this._REPORT_OPTIONS_START
        : this._REPORT_OPTIONS_PAUSE,
    );
  }

  private async _startMessageOnReport(chatId, userId) {
    this._bot.sendMessage(chatId, 'Set title to the report').then(() => {
      this._bot.onText(/./, async (msg, match) => {
        const newTitle = msg.text;
        const message = await this._sendMessageOnReport(
          chatId,
          newTitle,
          'start',
        );
        const newReport = new this._reportModel({
          userId: userId,
          dateStart: new Date(),
          title: newTitle,
          messageId: message.message_id,
          completed: false,
        });
        newReport.save().then(async (sevedReport) => {
          await this._resetTextListeners();
        });
      });
    });
  }

  private async _updateMessageOnReport(chatId, messageId, mode, newCommand) {
    try {
      if (newCommand === false) {
        await this._bot.deleteMessage(chatId, messageId);
      }

      const reportByMessageId = await this._getReportByMessageId(messageId);

      const newMessage = await this._sendMessageOnReport(
        chatId,
        reportByMessageId?.title,
        mode,
      );

      const candidateReport = await this._reportModel.findByIdAndUpdate(
        reportByMessageId._id,
      );
      candidateReport.messageId = newMessage.message_id;
      await candidateReport.save();

      if (mode === 'start') {
        await this._pausePauseOnReport(reportByMessageId._id);
      } else if (mode === 'pause') {
        await this._startPauseOnReport(reportByMessageId._id);
      }
    } catch (e) {
      console.log(e);
    }
  }

  private async _getReportByMessageId(messageId) {
    const result = await this._reportModel.findOne({ messageId: messageId });
    return !!result ? result : null;
  }

  private async _startPauseOnReport(reportId) {
    const result = await this._reportModel.findById(reportId);
    const indexNotEnded = result.pause.map((element, index) => {
      if (element.pauseEnd === null) {
        return index;
      }
    });
    if (indexNotEnded.length > 0) {
      indexNotEnded.forEach((index) => {
        result.pause[index].pauseEnd = new Date();
      });
    }
    result.pause.push(new PauseModel().getPause());
    return await result.save();
  }

  private async _pausePauseOnReport(reportId) {
    const result = await this._reportModel.findById(reportId);
    const indexNotEnded = result.pause.map((element, index) => {
      if (element.pauseEnd === null) {
        return index;
      }
    });
    if (indexNotEnded.length > 0) {
      indexNotEnded.forEach((index) => {
        result.pause[index].pauseEnd = new Date();
      });
    }
    return await result.save();
  }

  private async _reportIsNotPaused(reportId) {
    const result = await this._reportModel.findById(reportId);
    const indexNotEnded = result.pause.map((element, index) => {
      if (element.pauseEnd === null) {
        return index;
      }
    });
    return indexNotEnded;
  }
}
