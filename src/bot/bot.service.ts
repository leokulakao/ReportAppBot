import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { User, UserDocument } from './schemas/user.schema';
import * as TelegramBot from 'node-telegram-bot-api';
import { Report, ReportDocument } from './schemas/report.schema';
import * as moment from 'moment';
import * as momentTz from 'moment-timezone';
import { find } from 'geo-tz';

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
      reportDateEnd = +moment.utc();
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
      const now = moment(report.pause[i]?.pauseEnd).utc();
      const end = moment(report.pause[i]?.pauseStart).utc();
      const duration = moment.duration(now.diff(end));
      durationPause = durationPause + +duration.asSeconds();
    }
    const durationReportWithoutPause = durationReport - durationPause;
    return durationReportWithoutPause;
  }

  private async _getDurationInDateFormat(durationInSeconds, chatId) {
    const userLang = await (await this._getUserByChatId(chatId)).lang;
    let minutes = 0;
    let hours = 0;
    if (durationInSeconds > 0) {
      minutes = durationInSeconds / 60;
      if (minutes > 60) {
        hours = minutes / 60;
        minutes = minutes - hours * 60;
      }
    }
    return {
      minutes: Math.trunc(minutes),
      hours: Math.trunc(hours),
      minutesText: this._getTranslate(userLang, 'REPORT_MINUTES'),
      hoursText: this._getTranslate(userLang, 'REPORT_HOURS'),
      durationResultText:
        Math.trunc(hours) +
        ' ' +
        this._getTranslate(userLang, 'REPORT_HOURS') +
        ', ' +
        Math.trunc(minutes) +
        ' ' +
        this._getTranslate(userLang, 'REPORT_MINUTES'),
      lang: userLang,
    };
  }

  private async _resetTextListeners() {
    await this._bot.clearTextListeners();
    await this._bot.removeListener('location');
    this._onStart();
    this._onReport();
    this._onLocation();
    this._onStats();
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
        {
          command: 'location',
          description: this._getTranslate(
            msg.from.language_code,
            'COMMAND_LOCATION',
          ),
        },
      ]);
      const chatId = msg.chat.id;
      const candidate = await this._userModel.find({ chatId: chatId });
      if (candidate.length === 0) {
        console.log(msg);
        const createUser = new this._userModel({
          chatId: chatId,
          firstName: msg.from.first_name ? msg.from.first_name : '',
          lastName: msg.from.last_name ? msg.from.last_name : '',
          username: msg.from.username,
          date: +moment.utc(),
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
      console.log(callbackQuery);
      const reportCandidate = await this._getReportNoCompleted();
      if (!!reportCandidate) {
        switch (callbackQuery?.data) {
          case 'report_get_time':
            if (reportCandidate.messageId == callbackQuery.message.message_id) {
              const timeResult = await this._getDurationInDateFormat(
                await this._countReportTimeInSeconds(reportCandidate._id),
                callbackQuery.message.chat.id,
              );
              this._bot.answerCallbackQuery(
                callbackQuery?.id,
                timeResult.durationResultText,
              );
            } else {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Not Valid');
            }
            break;
          case 'report_pause_start':
            if (reportCandidate.messageId == callbackQuery.message.message_id) {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Hola');
              await this._startPause(reportCandidate._id);
              await this._bot.editMessageText(callbackQuery.message.text, {
                chat_id: callbackQuery.message.chat.id,
                message_id: callbackQuery.message.message_id,
                reply_markup: this._getInlineKeyboardForReport(
                  'stop',
                  reportCandidate._id,
                ).reply_markup,
              });
              // await this._sendReport(
              //   callbackQuery.message.chat.id,
              //   reportCandidate._id,
              //   'pause',
              // );
              // await this._bot.deleteMessage(
              //   callbackQuery.message.chat.id,
              //   callbackQuery.message.message_id,
              // );
            } else {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Not Valid');
            }
            break;
          case 'report_pause':
            if (reportCandidate.messageId == callbackQuery.message.message_id) {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Hola');
              await this._bot.editMessageText(callbackQuery.message.text, {
                chat_id: callbackQuery.message.chat.id,
                message_id: callbackQuery.message.message_id,
                reply_markup: this._getInlineKeyboardForReport(
                  'start',
                  reportCandidate._id,
                ).reply_markup,
              });
              // await this._sendReport(
              //   callbackQuery.message.chat.id,
              //   reportCandidate._id,
              //   'start',
              // );
              // await this._bot.deleteMessage(
              //   callbackQuery.message.chat.id,
              //   callbackQuery.message.message_id,
              // );
              await this._stopPause(reportCandidate._id);
            } else {
              this._bot.answerCallbackQuery(callbackQuery?.id, 'Not Valid');
            }
            break;
          case 'report_stop':
            if (reportCandidate.messageId == callbackQuery.message.message_id) {
              await this._reportComplete(reportCandidate._id);
              await this._bot.editMessageText(callbackQuery.message.text, {
                chat_id: callbackQuery.message.chat.id,
                message_id: callbackQuery.message.message_id,
              });
              // await this._bot.deleteMessage(
              //   callbackQuery.message.chat.id,
              //   callbackQuery.message.message_id,
              // );
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
          case 'current_year':
            await this._bot.editMessageText(callbackQuery.message.text, {
              chat_id: callbackQuery.message.chat.id,
              message_id: callbackQuery.message.message_id,
            });
            await this._getStatsMouth(
              callbackQuery.message.chat.id,
              moment().utc().year(),
            );
            await this._resetTextListeners();
            break;
          case 'prev_year':
            await this._bot.editMessageText(callbackQuery.message.text, {
              chat_id: callbackQuery.message.chat.id,
              message_id: callbackQuery.message.message_id,
            });
            await this._bot.sendMessage(
              callbackQuery.message.chat.id,
              'Año elegido es: ' + (moment().utc().year() - 1),
            );
            await this._resetTextListeners();
            break;
          case 'prev_prev_year':
            await this._bot.editMessageText(callbackQuery.message.text, {
              chat_id: callbackQuery.message.chat.id,
              message_id: callbackQuery.message.message_id,
            });
            await this._bot.sendMessage(
              callbackQuery.message.chat.id,
              'Año elegido es: ' + (moment().utc().year() - 2),
            );
            await this._resetTextListeners();
            break;
          case 'mouth_6':
            await this._bot.editMessageText(callbackQuery.message.text, {
              chat_id: callbackQuery.message.chat.id,
              message_id: callbackQuery.message.message_id,
            });
            await this._bot.sendMessage(
              callbackQuery.message.chat.id,
              'Año elegido es: ' + (moment().utc().year() - 2),
            );
            await this._resetTextListeners();
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
          await this._createReport(chatId, candidate._id);
        }
      }
    });
  }

  private _onLocation() {
    this._bot.onText(/\/location/, async (msg, match) => {
      const chatId = msg.chat.id;
      const candidate = await this._userModel.findOne({ chatId: chatId });
      if (!!candidate) {
        await this._changeTz(chatId, candidate._id);
      }
    });
  }

  private _onStats() {
    this._bot.onText(/\/stats/, async (msg, match) => {
      const chatId = msg.chat.id;
      const candidate = await this._userModel.findOne({ chatId: chatId });
      if (!!candidate) {
        await this._getStats(chatId, candidate._id);
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
      pauseStart: +moment.utc(),
      pauseEnd: 0,
    });
    await result.save();
  }

  private async _stopPause(reportId) {
    const result = await this._reportModel.findByIdAndUpdate(reportId);
    result.pauseOn = false;
    result.pause[result.pause.length - 1] = {
      pauseStart: result.pause[result.pause.length - 1].pauseStart,
      pauseEnd: +moment.utc(),
    };
    await result.save();
  }

  private async _sendReport(chatId, reportId, mode = 'start') {
    const result = await this._reportModel.findByIdAndUpdate(reportId);
    const user = await this._getUserByChatId(chatId);
    const message = await this._bot.sendMessage(
      chatId,
      this._getTranslate(user.lang, 'REPORT_MAIN_MESSAGE_1') +
        result.title +
        this._getTranslate(user.lang, 'REPORT_MAIN_MESSAGE_2') +
        this._getTranslate(user.lang, 'REPORT_MAIN_MESSAGE_3') +
        this._getTimeInString(
          result.dateStart,
          !!user.tz ? user.tz : null,
          user.lang,
          'LLLL',
        ),
      this._getInlineKeyboardForReport(mode, reportId),
    );
    const setMessageId = await this._reportModel.findByIdAndUpdate(reportId, {
      messageId: message.message_id,
    });
    await setMessageId.save();
  }

  private _getTimeInString(momentData, timezone, userLang, format): string {
    if (!!timezone) {
      return momentTz(momentData).tz(timezone).locale(userLang).format(format);
    } else {
      return (
        moment(momentData).utc().locale(userLang).format(format) + ' (UTC)'
      );
    }
  }

  private async _getUserByChatId(chatId) {
    const result = await this._userModel.findOne({ chatId: chatId });
    return result;
  }

  private async _changeTz(chatId, userId) {
    const user = await this._getUserByChatId(chatId);
    await this._bot.clearTextListeners();
    const result = await this._bot
      .sendMessage(
        chatId,
        this._getTranslate(user.lang, 'TIMEZONE_CHANGE_TEXT'),
        this._getReplyKeyboardForLocation(),
      )
      .then(async (msgResult) => {
        return msgResult;
      });
    // console.log('result ->', result);

    this._bot.on('location', async (msg) => {
      // console.log(msg);
      const candidate = await this._userModel.findById(user._id);
      candidate.tz = find(msg.location.latitude, msg.location.longitude)[0];
      await candidate.save();
      await this._bot.sendMessage(
        chatId,
        'Location recived',
        this._getReplyKeyboardForLocation(false),
      );
      await this._resetTextListeners();
    });
    await this._bot.once('message', async (msg) => {
      await this._bot.deleteMessage(result.chat.id, result.message_id);
      this._getReplyKeyboardForLocation(false);
      await this._resetTextListeners();
    });
  }

  private async _getStats(chatId, userId) {
    const user = await this._getUserByChatId(chatId);
    this._getStatsYear(chatId, userId, user);
  }

  private async _getStatsYear(chatId, userId, user) {
    const initMessage = await this._bot
      .sendMessage(
        chatId,
        'Pon año o eligi de los sigientes',
        this._getInlineKeyboardForYears(),
      )
      .then((returnMsg) => {
        return returnMsg;
      });
    await this._bot.clearTextListeners();
    this._bot.onText(/./, async (msg, match) => {
      if (msg.text.match(/^(19|20)[\d]{2,2}$/)) {
        console.log(msg.text);
        await this._bot.editMessageText(initMessage.text, {
          chat_id: initMessage.chat.id,
          message_id: initMessage.message_id,
        });
      } else {
        await this._bot.sendMessage(chatId, 'Año incorrecto');
      }
      await this._resetTextListeners();
    });
  }

  private async _getStatsMouth(chatId, year) {
    const initMessage = await this._bot
      .sendMessage(
        chatId,
        'Año elegifo es: ' + year,
        this._getInlineKeyboardFroMouth(),
      )
      .then((returnMsg) => {
        return returnMsg;
      });
  }

  // private async _sendStats(userId, year, mouth) {
  //   const result =
  // }

  private async _createReport(chatId, userId) {
    const user = await this._getUserByChatId(chatId);
    await this._bot.sendMessage(
      chatId,
      this._getTranslate(user.lang, 'REPORT_TITLE_INIT'),
    );
    this._bot.onText(/./, async (msg, match) => {
      const result = new this._reportModel({
        userId: userId,
        title: msg.text,
        dateStart: +moment.utc(),
      });
      await result.save();
      await this._sendReport(chatId, result._id);
      await this._resetTextListeners();
    });
  }

  private _getInlineKeyboardForYears() {
    const result = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[]],
      },
    };

    const year = moment().utc().year();

    for (let i = 0; i < 3; i++) {
      result.reply_markup.inline_keyboard[0].push({
        text: year - i,
        callback_data:
          i == 0 ? 'current_year' : i == 1 ? 'prev_year' : 'prev_prev_year',
      });
    }
    return result;
  }

  private _getInlineKeyboardFroMouth() {
    return {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Junio',
              callback_data: 'mouth_6',
            },
          ],
        ],
      },
    };
  }

  private _getReplyKeyboardForLocation(mode = true) {
    if (!!mode) {
      return {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            [
              {
                text: 'Mi location',
                request_location: true,
              },
            ],
            ['Cancel'],
          ],
        },
      };
    } else {
      return {
        parse_mode: 'Markdown',
        reply_markup: { remove_keyboard: true },
      };
    }
  }

  private _getInlineKeyboardForReport(mode, reportId) {
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
      dateEnd: +moment.utc(),
    });
    await result.save();
  }
}
