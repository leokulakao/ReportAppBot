import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import * as TelegramBot from 'node-telegram-bot-api';
import { Report, ReportDocument } from './schemas/report.schema';
import * as moment from 'moment';

import * as EN from './i18n/en.json';
import * as ES from './i18n/es.json';
@Injectable()
export class BotService {
  private _bot: TelegramBot;
  private _token: string;

  private _LANG_LIST = {
    en: EN,
    es: ES,
  };

  constructor(
    @InjectModel(User.name) private _userModel: Model<UserDocument>,
    @InjectModel(Report.name) private _reportModel: Model<ReportDocument>,
  ) {}

  onModuleInit() {
    this._token = this._getToken();
    this._bot = new TelegramBot(this._token, { polling: true });
    console.log('Telegram Bot started');
    this._onCallbackQuery();
    this._resetTextListeners();
  }

  private _getToken(): string {
    return process.env.BOT_TOKEN;
  }

  private _getTranslate(userLang: string, key: string): string {
    if (!!key || key.length > 0) {
      switch (userLang) {
        case 'en':
          return this._LANG_LIST['en'][key];
          break;
        case 'es':
          return this._LANG_LIST['es'][key];
          break;
        default:
          return this._LANG_LIST['en'][key];
          break;
      }
    }
  }

  private async _countReportTimeInSeconds(reportId) {
    const report = await this._reportModel.findById(reportId);

    let reportDateEnd = report.dateEnd;
    let reportDateStart = report.dateStart;

    if (!report.completed) {
      reportDateEnd = +moment().utc();
      reportDateStart = report.dateStart;
    }

    if (report.pauseOn) {
      reportDateEnd = +report.pause[report.pause.length - 1]?.pauseEnd;
      reportDateStart = report.dateStart;
    }

    const durationReport = moment
      .duration(moment(reportDateEnd).diff(reportDateStart))
      .asSeconds();

    let durationPause = 0;

    for (let i = 0; i < report.pause.length; i++) {
      const now = moment(report.pause[i]?.pauseEnd);
      const end = moment(report.pause[i]?.pauseStart);
      const duration = moment.duration(now.diff(end));
      durationPause = durationPause + +duration.asSeconds();
    }
    const durationReportWithoutPause = durationReport - durationPause;
    return durationReportWithoutPause;
  }

  private async _resetTextListeners() {
    await this._bot.clearTextListeners();
    this._onStart();
    this._onReport();
  }

  private _onStart() {
    this._bot.onText(/\/start/, async (msg, match) => {
      this._bot.setMyCommands([
        {
          command: 'start',
          description: this._getTranslate(
            msg.from.language_code,
            'COMMAND_START',
          ),
        },
        {
          command: 'report',
          description: this._getTranslate(
            msg.from.language_code,
            'COMMAND_REPORT',
          ),
        },
      ]);
      console.log('msg', msg);
      const chatId = msg.chat.id;
      const candidate = await this._userModel.find({ chatId: chatId });
      if (candidate.length === 0) {
        console.log(msg);
        const createUser = new this._userModel({
          chatId: chatId,
          firstName: msg.from.first_name ? msg.from.first_name : '',
          lastName: msg.from.last_name ? msg.from.last_name : '',
          username: msg.from.username,
          date: moment().utc(),
          lang: msg.from.language_code,
        });
        await createUser.save();
        this._bot.sendMessage(
          chatId,
          this._getTranslate(msg.from.language_code, 'USER_WELCOME'),
        );
      } else {
        const updateUser = await this._userModel.findOne({ chatId: chatId });
        updateUser.firstName = msg.from.first_name ? msg.from.first_name : '';
        updateUser.lastName = msg.from.last_name ? msg.from.last_name : '';
        updateUser.username = msg.from.username;
        updateUser.lang = msg.from.language_code;
        await updateUser.save();
        this._bot.sendMessage(
          chatId,
          this._getTranslate(msg.from.language_code, 'USER_HELLO'),
        );
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
              this._bot.answerCallbackQuery(
                callbackQuery?.id,
                await this._countReportTimeInSeconds(reportCandidate._id),
              );
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
      pauseStart: +moment().utc(),
      pauseEnd: 0,
    });
    await result.save();
  }

  private async _stopPause(reportId) {
    const result = await this._reportModel.findByIdAndUpdate(reportId);
    result.pauseOn = false;
    result.pause[result.pause.length - 1] = {
      pauseStart: result.pause[result.pause.length - 1].pauseStart,
      pauseEnd: +moment().utc(),
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

  private async _getUserByChatId(chatId) {
    const result = await this._userModel.findOne({ chatId: chatId });
    return result;
  }

  private async _createReport(chatId, userId) {
    const user = await this._getUserByChatId(chatId);
    console.log(user);
    await this._bot.sendMessage(
      chatId,
      this._getTranslate(user.lang, 'REPORT_TITLE_INIT'),
    );
    this._bot.onText(/./, async (msg, match) => {
      const result = new this._reportModel({
        userId: userId,
        title: msg.text,
        dateStart: +moment().utc(),
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
      dateEnd: +moment().utc(),
    });
    await result.save();
  }
}
