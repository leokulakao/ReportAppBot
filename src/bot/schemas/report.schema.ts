import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ReportDocument = Report & Document;

@Schema()
export class Report {
  @Prop({ required: true })
  userId: string;

  @Prop()
  messageId: string;

  @Prop({ default: false })
  title: string;

  @Prop({ required: true })
  dateStart: number;

  @Prop()
  dateEnd: number;

  @Prop()
  pause: [
    {
      pauseStart: number;
      pauseEnd: number;
    },
  ];

  @Prop({ required: true, default: false })
  pauseOn: boolean;

  @Prop()
  publications: number;

  @Prop()
  videos: number;

  @Prop()
  revisit: number;

  @Prop()
  studies: number;

  @Prop()
  note: string;

  @Prop({ required: true, default: false })
  completed: boolean;
}

export class PauseModel {
  pauseStart: Date;
  pauseEnd: Date;
  constructor() {
    this.pauseStart = new Date();
    this.pauseEnd = null;
  }

  setEnd() {
    this.pauseEnd = new Date();
  }

  getPause() {
    return { pauseStart: this.pauseStart, pauseEnd: this.pauseEnd };
  }
}

export const ReportSchema = SchemaFactory.createForClass(Report);
