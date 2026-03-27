import type { ChatDomain } from '../domain';

export interface PediVehicle {
  plate_number: string;
  body_number: string;
  color: string;
  brand: string;
}

export interface PediLocation {
  latitude: number;
  longitude: number;
}

export type PediRole = 'driver' | 'rider';

export type PediMessageType =
  | 'chat'
  | 'driver_arrived'
  | 'booking_started'
  | 'booking_completed'
  | 'booking_cancelled'
  | 'system_notice';

export interface PediParticipantMeta {
  vehicle?: PediVehicle;
  rating?: number;
  current_location?: PediLocation | null;
  [key: string]: unknown;
}

export interface PediMessageAttributes {
  location?: PediLocation;
  device?: 'android' | 'ios';
  app_version?: string;
  booking_id?: string;
  booking_status?: string;
  [key: string]: unknown;
}

export interface PediChat extends ChatDomain {
  role: PediRole;
  metadata: PediParticipantMeta;
  messageType: PediMessageType;
  attributes: PediMessageAttributes;
}
