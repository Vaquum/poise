import type { ReviewsObservation } from './chat/control'

const EMPTY_BODY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

export function addReviewBasis(revisions: Map<string, unknown>, page: ReviewsObservation, author: string): void {
  for (const review of page.reviews) {
    if (review.author?.toLowerCase() === author.toLowerCase() && review.state === 'COMMENTED' && review.revision === EMPTY_BODY) continue
    revisions.set(`review:${review.id}`, [review.state, review.revision])
  }
  for (const comment of page.comments ?? []) if (comment.author?.toLowerCase() !== author.toLowerCase()) {
    revisions.set(`comment:${comment.id}`, [comment.thread, comment.resolved, comment.revision])
  }
}
