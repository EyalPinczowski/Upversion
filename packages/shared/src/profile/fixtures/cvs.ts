/**
 * Fictional CVs for the matcher tests. Every name, address, number and employer is invented;
 * none of this is a real person's data.
 */

/** Contact details that must never appear in any matcher output or import payload. */
export const CONTACT_STRINGS = [
  'dana.example@example.com',
  'dana.example',
  '+1 555 010 0199',
  '555 010 0199',
  'www.dana-example.com',
  'linkedin.com/in/dana-example',
  '@dana_example',
  'Dana Example',
];

/** One sentence that must never be copied whole into any output. */
export const CANARY =
  'I reconciled the quarterly figures for the purple walrus cooperative using Excel while humming sea shanties.';

export const CV_NOW = new Date('2026-06-15T00:00:00Z');

const HEADER = `Dana Example
dana.example@example.com | +1 555 010 0199 | linkedin.com/in/dana-example | @dana_example
`;

/** Ops CV: sections, three date formats, a canary sentence and contact details in the body. */
export const opsCv = `${HEADER}
Summary
Operations professional who likes tidy processes.

Experience
Operations Analyst, Acme Widgets Ltd    03/2018 - 06/2021
- ${CANARY}
- Built dashboards in Power BI and ran project management routines.
- Portfolio at www.dana-example.com and Excel templates by dana.example@example.com

Operations Manager (junior) | Globex Corp
Jan 2022 – Present
- Introduced Jira for the whole team.

Education
B.Sc in Industrial Engineering, Example University, 2012 – 2016

Skills
Excel, SQL, Jira, monday.com, ASP.NET
`;

/** Data analyst CV. */
export const analystCv = `${HEADER}
Profile
Analyst who enjoys data.

Work Experience
Data Analyst at Initech Ltd    2019 – 2023
- Wrote SQL queries and built Tableau dashboards for the sales team.
- Automated reports with Python scripts.
Junior Analyst | Hooli Inc | 2017-2019
- Data cleaning and data visualization for weekly reports.

Education
MSc in Statistics, Example University

Technical Skills
SQL, Python, Tableau, Excel
`;

/** Career changer: a teacher moving to tech; courses and a bootcamp, no matching role title. */
export const changerCv = `${HEADER}
Experience
High School Teacher | Riverside School | 2012 - 2024
- Planned lessons and parent meetings.
- Used Google Sheets for grade books.

Education
Bachelor of Arts in History, Example College
Web development bootcamp, Example Academy, 2024

Skills
Google Sheets, Notion, HTML
`;

/** Hebrew lines mixed with Latin tool names. */
export const hebrewCv = `${HEADER}
ניסיון
מנהל תפעול | חברת דוגמה | 2018 – 2022
- ניהול פרויקטים בעזרת Jira ו-Excel
- עבודה עם SQL ו-Power BI

השכלה
תואר ראשון B.Sc בהנדסה, אוניברסיטת דוגמה

כישורים
Excel, SQL, Zapier
`;

/** Two columns read left-then-right: skills column lines interleave with the experience column. */
export const twoColumnCv = `${HEADER}
Skills
Experience
SQL
Operations Analyst, Acme Widgets Ltd
Tableau
03/2019 - 03/2023
Excel
- Built Tableau dashboards and cleaned data with SQL.
Education
Jira
B.A. in Economics, Example University
`;

/** No section headings at all: the first 2 lines are the contact block. */
export const noSectionsCv = `Dana Example
dana.example@example.com | +1 555 010 0199
Operations Analyst, Acme Widgets Ltd, 03/2018 - 06/2021
Built Power BI dashboards and used project management tools every day.
Skills: Excel, SQL
`;
