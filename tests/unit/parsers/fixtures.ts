// HTML-фикстуры для адаптеров. Не пытаются воспроизвести вёрстку 1-в-1,
// но содержат правильные селекторы и структуру, на которую полагаются адаптеры.

export const AUTHOR_TODAY_HTML = `<!doctype html>
<html lang="ru">
  <head>
    <title>Глава 12. Дуэль на закате — Северный род | author.today</title>
  </head>
  <body>
    <header>
      <div class="book-title"><a href="/work/12345">Северный род</a></div>
      <h1 class="chapter-title">Глава 12. Дуэль на закате</h1>
    </header>
    <div id="text-container">
      <div class="reader-text">
        <p>Алексей Волков шагнул вперёд. Снег скрипел под сапогами.</p>
        <p>Противник поднял пистолет. Раздался выстрел.</p>
        <p>—  Я ранен, — прошептал Алексей и упал на одно колено.</p>
        <div class="ads">Реклама не должна попасть в текст</div>
      </div>
    </div>
  </body>
</html>`;

export const FICBOOK_HTML = `<!doctype html>
<html lang="ru">
  <head>
    <title>Серебряный лес — глава 3 | Книга Фанфиков</title>
    <meta property="og:title" content="Серебряный лес" />
  </head>
  <body>
    <section class="fanfic-main-info">
      <h1>Серебряный лес</h1>
    </section>
    <article>
      <h2 class="part-name">Часть 3. Под луной</h2>
      <div id="content">
        <p>Мария вошла в чащу. Луна заливала тропу.</p>
        <p>Где-то вдалеке выл волк.</p>
      </div>
    </article>
  </body>
</html>`;

export const ROYAL_ROAD_HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>Chapter 7: The Awakening — Worldforge | Royal Road</title>
  </head>
  <body>
    <div class="fic-header">
      <h1>Worldforge</h1>
    </div>
    <h1 class="font-white">Chapter 7: The Awakening</h1>
    <div class="chapter-inner chapter-content">
      <p>Aldric opened his eyes for the first time in a thousand years.</p>
      <p>The runes on his palms glowed faintly.</p>
      <p>He stood up.</p>
    </div>
  </body>
</html>`;

export const GENERIC_HTML = `<!doctype html>
<html lang="en">
  <head>
    <title>How to write good prose — Some Blog</title>
    <meta property="og:site_name" content="Some Blog" />
    <link rel="canonical" href="https://some.example/articles/how-to-write" />
  </head>
  <body>
    <header>Site nav stuff</header>
    <article>
      <h1>How to write good prose</h1>
      <p>${"Lorem ipsum dolor sit amet ".repeat(40)}</p>
      <p>${"Consectetur adipiscing elit, sed do eiusmod tempor. ".repeat(40)}</p>
      <p>${"Ut labore et dolore magna aliqua. ".repeat(40)}</p>
    </article>
    <footer>Copyright</footer>
  </body>
</html>`;
