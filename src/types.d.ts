declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";

  export interface TaskListsOptions {
    /** false renders the checkboxes disabled (read-only reader). */
    enabled?: boolean;
    label?: boolean;
  }

  export default function taskLists(md: MarkdownIt, options?: TaskListsOptions): void;
}
