export type Layout = 'table' | 'cards' | 'detailsFirst' | 'unknown';

export interface ListingAdapter {
  detectLayout(page: any): Promise<Layout>;
  openListing(page: any, baseUrl: string): Promise<void>;
  findProgramContainer(page: any, nameRe: RegExp): Promise<{ container: any, layout: Layout }>;
  clickRegisterInContainer(page: any, container: any): Promise<void>;
  openDetailsThenRegister?(page: any, container: any): Promise<boolean>;
}