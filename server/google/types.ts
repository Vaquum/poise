import type { GoogleComment } from './markdown'
export interface GooglePublication {
  accountId: string
  fileId: string
  title: string
  url: string
  sourceSha: string
  remoteSha: string
  pending?: boolean
}
export interface GooglePublicationView extends GooglePublication {
  email: string
  connected: boolean
  remoteChanged: boolean | null
  localChanged: boolean
  comments: GoogleComment[]
  problem?: string
}
export interface GoogleDocumentView { version: string, publications: GooglePublicationView[] }
export interface GoogleChangeReview { fileId: string, connectionVersion: string, localText: string, remoteText: string, localVersion: string, remoteSha: string, comments: GoogleComment[] }
