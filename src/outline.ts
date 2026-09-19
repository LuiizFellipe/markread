export interface Heading {
  id: string;
  text: string;
  level: number;
}

export function collectHeadings(container: HTMLElement): Heading[] {
  const headings: Heading[] = [];
  container.querySelectorAll("h1, h2, h3, h4").forEach((h) => {
    headings.push({
      id: h.id,
      text: (h.textContent ?? "").trim(),
      level: Number(h.tagName.slice(1)),
    });
  });
  return headings;
}

/** Build a nested <ul> tree from the flat heading list. Lookups are scoped
 *  to the article root so raw-HTML heading ids cannot hijack navigation. */
export function renderOutline(
  nav: HTMLElement,
  headings: Heading[],
  emptyLabel: string,
  root: HTMLElement,
): void {
  nav.innerHTML = "";

  if (headings.length === 0) {
    const empty = document.createElement("span");
    empty.className = "outline-empty";
    empty.textContent = emptyLabel;
    nav.appendChild(empty);
    return;
  }

  const tree = document.createElement("ul");
  let currentList: HTMLUListElement = tree;
  let currentLevel = headings[0].level;
  let currentItem: HTMLLIElement | null = null;

  for (const heading of headings) {
    if (heading.level > currentLevel && currentItem) {
      const nested = document.createElement("ul");
      currentItem.appendChild(nested);
      currentList = nested;
      currentLevel = heading.level;
    }
    while (heading.level < currentLevel && currentList !== tree && currentList.parentElement) {
      currentList = currentList.parentElement.closest("ul") ?? tree;
      currentLevel -= 1;
    }
    if (heading.level < currentLevel) currentLevel = heading.level;

    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = `#${heading.id}`;
    a.dataset.target = heading.id;
    a.textContent = heading.text;
    a.addEventListener("click", (ev) => {
      ev.preventDefault();
      headingById(root, heading.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    li.appendChild(a);
    currentList.appendChild(li);
    currentItem = li;
  }

  nav.appendChild(tree);
}

function headingById(root: HTMLElement, id: string): HTMLElement | null {
  return root.querySelector(`#${CSS.escape(id)}`);
}

/** Highlight the outline entry for the heading nearest the top of the view. */
export function initScrollSpy(
  scrollPane: HTMLElement,
  nav: HTMLElement,
  getHeadings: () => Heading[],
  root: HTMLElement,
): () => void {
  let ticking = false;

  function update(): void {
    ticking = false;
    const headings = getHeadings();
    if (headings.length === 0) return;
    const scrollTop = scrollPane.scrollTop + 96;
    let activeId = headings[0].id;
    for (const heading of headings) {
      const el = headingById(root, heading.id);
      if (el && el.offsetTop <= scrollTop) activeId = heading.id;
    }
    nav.querySelectorAll("a.active").forEach((a) => a.classList.remove("active"));
    const link = nav.querySelector<HTMLAnchorElement>(`a[data-target="${CSS.escape(activeId)}"]`);
    link?.classList.add("active");
  }

  function onScroll(): void {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(update);
    }
  }

  scrollPane.addEventListener("scroll", onScroll, { passive: true });
  return update;
}
