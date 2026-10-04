export type AnnouncementType = 'release' | 'announcement' | 'patch' | 'hotfix';

export interface ChangelogTag {
  label: string;
  color?: 'primary' | 'success' | 'warning' | 'info' | 'purple' | 'danger';
}

export interface ChangelogItem {
  id: string;
  type: AnnouncementType;
  version?: string;
  title: string;
  date: string;
  pinned?: boolean;
  tags?: ChangelogTag[];
  summary?: string;
  content: string;
  externalUrl?: string;
}

export interface ChangelogFilterOptions {
  type?: AnnouncementType | 'all';
  searchQuery?: string;
}
