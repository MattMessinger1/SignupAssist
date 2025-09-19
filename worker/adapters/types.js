// Layout adapter types for worker

export const LAYOUTS = {
  TABLE: 'table',
  CARDS: 'cards', 
  DETAILS_FIRST: 'detailsFirst',
  UNKNOWN: 'unknown'
};

// ListingAdapter interface:
// - detectLayout(page): Promise<Layout>
// - openListing(page, baseUrl): Promise<void>
// - findProgramContainer(page, nameRe): Promise<{ container, layout }>
// - clickRegisterInContainer(page, container): Promise<void>
// - openDetailsThenRegister?(page, container): Promise<boolean>