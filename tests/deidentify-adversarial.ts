/*
 * The adversarial review's inputs (review of 2026-11-22), with variants of each class of
 * leak, and the reviewer's client sheet. Invented people, places and numbers only.
 * Each probe lists the strings that must not survive (compared ignoring case and
 * accents) and, where it matters, what must survive or be reported.
 */
import type { ClientSheet } from "../src/main/deidentify/index.ts";

export const REVIEW_TODAY = new Date("2026-11-22T12:00:00Z");

export const REVIEW_SHEET: ClientSheet = {
  client: { firstName: "Mateo", lastName: "Ficticio Gómez", nicknames: ["Teo"], dateOfBirth: "2020-03-14" },
  caregivers: [
    { firstName: "Lucía", lastName: "Ficticio", relation: "mother" },
    { firstName: "Andrés", lastName: "Ficticio", relation: "father" },
  ],
  family: [{ firstName: "Valeria", lastName: "Ficticio Gómez", relation: "sister" }],
  professionals: [
    { firstName: "Daniela", lastName: "Muestra", relation: "BCBA" },
    { firstName: "Hope", lastName: "Brown", relation: "teacher" },
  ],
  schools: ["José Martí Elementary School"],
  addresses: ["4471 SW 12th Terrace, Apt 3, Miami, FL 33135"],
  phones: ["(305) 555-0142"],
  emails: ["lucia.ficticio@example.com"],
  ids: ["FL123456789", "9876543210"],
};

export interface Probe {
  group: string;
  text: string;
  hide: string[];
  keep?: string[];
}

const DOB_FORMS = [
  "14-Mar-2020", "14-mar-20", "Mar-14-2020", "14Mar2020", "14MAR20", "14/Mar/2020", "14.Mar.2020", "Mar/14/2020", "Mar-14-20",
  "2020/03/14", "2020.03.14", "2020-03-14", "03/14/2020", "3/14/20", "3-14-20", "03.14.2020", "March 14, 2020", "March 14 , 2020",
  "Mar. 14th 2020", "14 March 2020", "14th of March, 2020", "14 de marzo de 2020", "marzo 14, 2020", "14-MARZO-2020",
];

export const PROBES: Probe[] = [
  // B2: the date of birth in every format, alone and in a sentence
  ...DOB_FORMS.map((d) => ({ group: "B2 date of birth", text: `DOB: ${d}.`, hide: [d] })),
  ...DOB_FORMS.slice(0, 8).map((d) => ({ group: "B2 date of birth", text: `He was born on ${d} in Miami.`, hide: [d, "Miami"] })),
  { group: "B2 date of birth", text: "Birthday: 3/14", hide: ["3/14"] },
  { group: "B2 date of birth", text: "Su cumpleaños es el 14/3.", hide: ["14/3"] },
  { group: "B2 date of birth", text: "Party on 14th March", hide: ["14th March"] },
  { group: "B2 date of birth", text: "cumple el 14 de marzo. 14th March.", hide: ["14 de marzo", "14th March"] },
  { group: "B2 date of birth", text: "Born in March 2020; birthday March 14.", hide: ["March 2020", "March 14"] },
  { group: "B2 anniversary", text: "He turned 6 on 03/14/2026.", hide: ["03/14/2026"] },
  { group: "B2 anniversary", text: "His birthday party was March 14, 2026.", hide: ["March 14, 2026"] },
  { group: "B2 anniversary", text: "Cumplió 6 el 14 de marzo de 2026.", hide: ["14 de marzo de 2026"] },
  { group: "B2 anniversary", text: "Celebrated 14-Mar-2025 at home.", hide: ["14-Mar-2025"] },
  // H4: old dates in the same formats
  { group: "H4 old dates", text: "Diagnosed 14-Jun-2019 and re-evaluated 02-Feb-2023.", hide: ["14-Jun-2019", "02-Feb-2023"] },
  { group: "H4 old dates", text: "Seen 2019/06/14; next 2023.02.02.", hide: ["2019/06/14", "2023.02.02"] },
  { group: "H4 old dates", text: "Recent visit 10/02/2026 stays.", hide: [], keep: ["10/02/2026"] },
  // B3: the sheet's address, abbreviated and without its number
  { group: "B3 address", text: "4471 SW 12th Terr., Unit 3, Miami FL 33135", hide: ["4471", "12th", "Terr", "Unit 3", "Miami", "33135"] },
  { group: "B3 address", text: "Lives on SW 12th Terrace near the park.", hide: ["12th Terrace"] },
  { group: "B3 address", text: "4471 Southwest Twelfth Terrace", hide: ["4471", "Twelfth"] },
  { group: "B3 address", text: "4471 S.W. 12 Terrace #3", hide: ["4471", "12 Terrace"] },
  { group: "B3 address", text: "Home is 4471 SW 12 Ter apt 3.", hide: ["4471", "12 Ter"] },
  { group: "B3 address", text: "address: 4471 sw 12th terrace, apt 3, miami, fl 33135", hide: ["4471", "12th terrace", "miami", "33135"] },
  { group: "B3 address", text: "4471 SW 12th Trce", hide: ["4471", "12th Trce"] },
  { group: "B3 address", text: "They moved from 4471 SW 12th Terrace last year.", hide: ["4471", "12th Terrace"] },
  // City (owner's decision): the sheet address's city, alone
  { group: "City", text: "The family lives in Miami.", hide: ["Miami"] },
  { group: "City", text: "Viven en miami desde 2021.", hide: ["miami"], keep: ["2021"] },
  { group: "City", text: "MIAMI, FL", hide: ["MIAMI"] },
  // B4: the school, short forms and initials
  { group: "B4 school", text: "He attends Marti Elementary.", hide: ["Marti Elementary"] },
  { group: "B4 school", text: "Martí Elementary called.", hide: ["Martí Elementary"] },
  { group: "B4 school", text: "Teachers at JMES report hitting.", hide: ["JMES"] },
  { group: "B4 school", text: "The JME staff agreed.", hide: ["JME"] },
  { group: "B4 school", text: "José Martí Elementary School and Jose Marti Elementary", hide: ["José Martí", "Jose Marti"] },
  { group: "B4 school", text: "jose marti elementary school", hide: ["jose marti"] },
  // B5: the sheet's phone and IDs in ordinary variants
  { group: "B5 phone", text: "Call 555-0142 after 5.", hide: ["555-0142"] },
  { group: "B5 phone", text: "Phone (305)555-0142 or 305 555 0142 or 305.555.0142 or 3055550142.", hide: ["555-0142", "555 0142", "555.0142", "3055550142"] },
  { group: "B5 phone", text: "+1 (305) 555-0142", hide: ["555-0142"] },
  { group: "B5 id", text: "ID FL 123 - 456 - 789", hide: ["123", "456", "789"] },
  { group: "B5 id", text: "Medicaid 123456789", hide: ["123456789"] },
  { group: "B5 id", text: "Medicaid ending in 3210", hide: ["3210"] },
  { group: "B5 id", text: "Last 4 of Medicaid: 6789", hide: ["6789"] },
  { group: "B5 id", text: "Member FL-123-456-789 and fl 123456789", hide: ["123-456-789", "123456789"] },
  { group: "B5 id", text: "Policy 98765 43210", hide: ["98765 43210"] },
  // B6: names joined to other text, suffixed, or split by invisible characters
  { group: "B6 joined", text: "File MateoFicticio.pdf attached.", hide: ["Mateo", "Ficticio"] },
  { group: "B6 joined", text: "Her handle is @mateoficticio and #TeamMateo.", hide: ["mateo", "ficticio"] },
  { group: "B6 joined", text: "mateo_ficticio_cde_2026.docx", hide: ["mateo", "ficticio"] },
  { group: "B6 joined", text: "Valerias toys and Mateos tablet", hide: ["Valeria", "Mateo"] },
  { group: "B6 joined", text: "Ficticios' house", hide: ["Ficticio"] },
  { group: "B6 invisible", text: "Fic\u{200D}ticio said", hide: ["Fic\u{200D}ticio", "Ficticio"] },
  { group: "B6 invisible", text: "Lu\u{200C}cía called", hide: ["Lu\u{200C}cía", "Lucía"] },
  { group: "B6 invisible", text: "Ma\u{2060}teo ran", hide: ["Ma\u{2060}teo", "Mateo"] },
  { group: "B6 invisible", text: "Mat\u{00AD}eo and Ma\u{200B}teo and Ma\u{180E}teo", hide: ["Mateo"] },
  { group: "B6 invisible", text: "Andr\u{E9}s and Andre\u{301}s", hide: ["Andrés", "Andres"] },
  // B1: letter-spaced text, as PDFs give it
  { group: "B1 spaced", text: "L u c i a | F i c t i c i o | i s | t h e | m o t h e r", hide: ["L u c i a", "F i c t i c i o"] },
  { group: "B1 spaced", text: "Examinee | M a t | e o | F i | c t | i | c i | o", hide: ["M a t | e o", "F i | c t | i | c i | o"] },
  { group: "B1 spaced", text: "Client: Ma | teo Ficti | cio", hide: ["Ma | teo", "Ficti | cio"] },
  { group: "B1 spaced", text: "V a l e r i a  attends", hide: ["V a l e r i a"] },
  // Names on the sheet, any form
  { group: "Names", text: "MATEO FICTICIO GÓMEZ; Ficticio, Mateo; M. Ficticio; Mateo F.; M.F.", hide: ["Mateo", "Ficticio", "Gómez", "M.F."] },
  { group: "Names", text: "Fic-\nticio and Ficti-\ncio Gómez", hide: ["Fic-\nticio", "Ficti-\ncio"] },
  { group: "Names", text: "Ficticio–Gómez family; Ficticio-Gomez", hide: ["Ficticio", "Gómez", "Gomez"] },
  { group: "Names", text: "la señora Ficticio y Sra. Gómez", hide: ["Ficticio", "Gómez"] },
  { group: "Names", text: "Lucía's notes; Ficticios' car; Teo's tablet", hide: ["Lucía", "Ficticio", "Teo"] },
  { group: "Names", text: "Daniela Muestra, M.S., BCBA", hide: ["Daniela", "Muestra"] },
  { group: "Names", text: "Ms. Brown and Hope Brown; hope and brown stay", hide: ["Ms. Brown", "Hope Brown"], keep: ["hope and brown stay"] },
  { group: "Names", text: "Hope said the brown bag was his.", hide: ["Hope said"], keep: ["brown bag"] },
  // M3: diminutives
  { group: "M3 diminutives", text: "Mateíto and Mateito and Teíto", hide: ["Mateíto", "Mateito", "Teíto"] },
  { group: "M3 diminutives", text: "Valerita and Luciita", hide: ["Valerita"] },
  // H4: people not on the sheet
  { group: "H4 people", text: "Ana María Prado-Ilustre, BCBA, signed.", hide: ["Ana María", "Prado-Ilustre"] },
  { group: "H4 people", text: "Signed: Rodrigo Ejemplar, M.D.", hide: ["Rodrigo", "Ejemplar"] },
  { group: "H4 people", text: "Coach Mike and Abuela Carmen and Tía Rosario help.", hide: ["Mike", "Carmen", "Rosario"] },
  { group: "H4 people", text: "his aunt Marisol and grandma Inés visit", hide: ["Marisol", "Inés"] },
  { group: "H4 people", text: "Su primo Bruno y su prima Elisa.", hide: ["Bruno", "Elisa"] },
  { group: "H4 people", text: "Teacher: Ms. Rivera.", hide: ["Rivera"], keep: ["Teacher: Ms."] },
  { group: "H4 people", text: "Examinee: Pablo Desconocido   DOB: 01/02/2019", hide: ["Pablo", "Desconocido", "01/02/2019"] },
  { group: "H4 people", text: "Dr. Tomás Ilustre referred him.", hide: ["Tomás", "Ilustre"] },
  // H4: phones, ZIP codes, Spanish-style streets, IDs after other labels
  { group: "H4 phones", text: "tel. 555 0199", hide: ["555 0199"] },
  { group: "H4 phones", text: "cel: 786-5550199", hide: ["5550199"] },
  { group: "H4 phones", text: "786/555/0199", hide: ["786/555/0199"] },
  { group: "H4 phones", text: "Cell 786 555 0199 ext 12", hide: ["786 555 0199"] },
  { group: "H4 addresses", text: "Lives in Doral 33172.", hide: ["33172"] },
  { group: "H4 addresses", text: "22 Calle Ocho, Miami", hide: ["22 Calle Ocho", "Miami"] },
  { group: "H4 addresses", text: "Apartment 3B at 900 Brickell Avenue", hide: ["3B", "900 Brickell"] },
  { group: "H4 addresses", text: "1500 Avenida Ponce de León, San Juan, PR 00909", hide: ["1500", "Ponce", "00909"] },
  { group: "H4 addresses", text: "P.O. Box 4410", hide: ["4410"] },
  { group: "H4 ids", text: "Florida KidCare 12345", hide: ["12345"] },
  { group: "H4 ids", text: "AETNA W1234 5678", hide: ["W1234", "5678"] },
  { group: "H4 ids", text: "Sunshine Health number is SH4471-22", hide: ["SH4471-22"] },
  { group: "H4 ids", text: "medicaid id is 1 2 3 4 5 6 7 8 9", hide: ["1 2 3 4 5 6 7 8 9"] },
  { group: "H4 ids", text: "SSN 123-45-6789; MRN 00456789; NPI 1234567893", hide: ["123-45-6789", "00456789", "1234567893"] },
  // Emails and URLs
  { group: "Emails", text: "Write to lucia.ficticio@example.com or LUCIA.FICTICIO@EXAMPLE.COM", hide: ["lucia.ficticio"] },
  { group: "Emails", text: "https://example.com/mateo-ficticio/report", hide: ["mateo", "ficticio"] },
  // M4: ages with days
  { group: "M4 ages", text: "Chronological age 6-8-8 on test date 11/22/2026", hide: ["6-8-8"], keep: ["11/22/2026", "6-8"] },
  { group: "M4 ages", text: "CA: 6;8;8", hide: ["6;8;8"], keep: ["6;8"] },
  { group: "M4 ages", text: "Age 6 years, 8 months, 8 days", hide: ["8 days"], keep: ["6 years, 8 months"] },
  { group: "M4 ages", text: "Edad: 6 años, 8 meses y 8 días", hide: ["8 días"], keep: ["6 años, 8 meses"] },
  { group: "M4 ages", text: "Age at testing 4:2 stays.", hide: [], keep: ["4:2"] },

  // Review round 2 (2026-11-22): its inputs, by class.
  { group: "R2 N1 hyphenated", text: "his mother, Lucia Fic-ticio, who works nights. His sister, Valeria Ficticio Go-mez, attends", hide: ["Fic-ticio", "Go-mez"] },
  { group: "R2 N1 hyphenated", text: "Ficti-cio Gó-mez family; Va-leria laughed; Fic- ticio; Ma-teo", hide: ["Ficti-cio", "Gó-mez", "Va-leria", "Fic- ticio", "Ma-teo", "Ma-"] },
  { group: "R2 N1 split", text: "M ateo, Fi cticio, Mat eo Fic ticio", hide: ["M ateo", "Fi cticio", "Mat eo", "Fic ticio"] },
  { group: "R2 N1 split", text: "Mar-tí Elementary and Mia-\nmi and Mar-\nch 14, 2020", hide: ["Mar-tí", "Mia-\nmi", "Mar-\nch 14"] },
  { group: "R2 N2 date of birth", text: "March the 14th, 2020", hide: ["14th", "2020"] },
  { group: "R2 N2 date of birth", text: "03 / 14 / 2020 and 03/14/ 2020 and 3/14/'20", hide: ["03 / 14 / 2020", "03/14/ 2020", "3/14/'20"] },
  { group: "R2 N2 date of birth", text: "DOB 031420; DOB 03142020; DOB 14032020", hide: ["031420", "03142020", "14032020"] },
  { group: "R2 N2 date of birth", text: "14-III-2020", hide: ["14-III-2020"] },
  // (Round 7: "celebrates" and "party" alone no longer make a number pair a birthday; "Celebrates on 14/3" is listed for review.)
  { group: "R2 N2 birthday", text: "turns 7 on 3/14. His birthday is coming up on 3/14. Celebrates his birthday on 14/3 every year.", hide: ["3/14", "14/3"] },
  { group: "R2 N2 birthday", text: "el catorce de marzo; the fourteenth of March; March fourteenth", hide: ["catorce de marzo", "fourteenth of March", "March fourteenth"] },
  { group: "R2 N3 compatibility", text: "Ｍａｔｅｏ and ＦＩＣＴＩＣＩＯ and Ｌｕｃíａ", hide: ["Ｍａｔｅｏ", "ＦＩＣＴＩＣＩＯ", "Ｌｕｃíａ"] },
  { group: "R2 N3 compatibility", text: "Daniela Muestra signed; Dani\u{FB01}cticio; Mu\u{FB06}stra", hide: ["Daniela", "Muestra"] },
  { group: "R2 L5 entities", text: "Luc&iacute;a and Luc&#237;a and Ficticio&#x20;G&oacute;mez", hide: ["Luc&iacute;a", "Luc&#237;a", "G&oacute;mez"] },
  { group: "R2 M4 old dates", text: "Seen 5 Jan 24 and Jan 5 '24.", hide: ["5 Jan 24", "Jan 5 '24"] },
  { group: "R2 M5 OCR", text: "Mate0, Luc1a, FlCTlClO, Matco", hide: ["Mate0", "Luc1a", "FlCTlClO", "Matco"] },
  { group: "R2 H5 ages", text: "Chronological age | 6:8:8; Age (Y:M:D) 6:08:08; 6 years 8 months & 8 days", hide: ["6:8:8", "6:08:08", "8 days"], keep: ["6:8", "6:08", "6 years 8 months"] },
  { group: "R2 H5 ages", text: "23 months 8 days; 80 months 8 days old; aged 6 years, 248 days; Chronological Age | 6 | 8 | 8", hide: ["8 days", "248 days", "| 8 | 8"], keep: ["23 months", "80 months old", "aged 6 years"] },
  { group: "R2 L1 ages", text: "6y8m8d. 6 y; CA = 6-08-08", hide: ["8d", "6-08-08"], keep: ["6y8m.", "6 y", "CA = 6-08"] },
  { group: "R2 L3 particles", text: "Sra. Lucía Ficticio de Gómez", hide: ["Lucía", "Ficticio", "Gómez"], keep: ["de"] },

  // Review round 3 (2026-11-22): its inputs, by class.
  { group: "R3 B1 spaced date", text: "DOB 03 14 2020; Born: 3 14 2020; 03 14 20", hide: ["03 14 2020", "3 14 2020", "03 14 20"] },
  { group: "R3 B1 table date", text: "Date of birth | 03 14 2020\nDate of birth | 03 | 14 | 2020", hide: ["03 14 2020", "03 | 14 | 2020"] },
  { group: "R3 B1 fields", text: "Month: 03 Day: 14 Year: 2020. Born | March | 14 | 2020. Birth month: March; birth day: 14; birth year: 2020", hide: ["Day: 14", "| 14 |", "birth day: 14"] },
  { group: "R3 B2 boxes", text: "Date of birth | 0 | 3 | 1 | 4 | 2 | 0 | 2 | 0\nPhone | 3 | 0 | 5 | 5 | 5 | 5 | 0 | 1 | 4 | 2\nMedicaid ID | F | L | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9", hide: ["0 | 3 | 1 | 4", "5 | 5 | 5 | 0 | 1 | 4 | 2", "1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9"] },
  { group: "R3 B2 text", text: "0 3 / 1 4 / 2 0 2 0; 0 3 1 4 2 0 2 0; Phone | 305 | 555 | 0142; 4 4 7 1  S W  1 2 t h  T e r r a c e; M i a m i", hide: ["0 3 / 1 4", "0 3 1 4 2 0 2 0", "555 | 0142", "4 4 7 1", "M i a m i"] },
  { group: "R3 B3 words", text: "three oh five, five five five, oh one four two; tres cero cinco cinco cinco cinco cero uno cuatro dos; 305-five five five-0142", hide: ["oh one four two", "cero uno cuatro dos", "five five five-0142"] },
  { group: "R3 B3 day of year", text: "born on the 74th day of 2020; DOB: 2020-074; catorce/03/2020", hide: ["74th", "2020-074", "catorce/03/2020"] },
  { group: "R3 B3 domains", text: "www.mateoficticio.com and https://ficticio.family.com", hide: ["mateoficticio", "ficticio.family"] },
  { group: "R3 B3 homoglyph", text: "Valeri\u{0430} and \u{041C}ateo and Fict\u{0456}cio", hide: ["Valeri\u{0430}", "\u{041C}ateo", "Fict\u{0456}cio"] },
  { group: "R3 B3 percent", text: "https://ex.com/Mat%C3%A9o and MATEO%20FICTICIO", hide: ["Mat%C3%A9o", "MATEO%20FICTICIO"] },
  { group: "R3 L5 nicknames", text: "Lucy and Andy came; Mom Lucy said so; Matty laughed", hide: ["Lucy", "Andy", "Matty"] },
];

/** Another invented sheet: names that, split, are ordinary words ("a dam", "no el"): those texts must come through as written. */
export const SPLIT_SHEET: ClientSheet = {
  client: { firstName: "Adam", lastName: "Noel" },
  caregivers: [{ firstName: "Inés", lastName: "Tomas" }, { firstName: "Elena", lastName: "Mora" }],
  professionals: [{ firstName: "Alma", lastName: "Sales" }],
};
export const SPLIT_CLINICAL = ["They built a dam in the park.", "No el niño no quiere.", "He said in es ok.", "To mas allá.", "A dam was drawn."];

/** Another invented sheet with a compound given name and a surname with particles (review round 3: H2, H3, H4). */
/** Round 4's Spanish sheet: the compound name with an address, a school and an ID. */
export const SPANISH_SHEET: ClientSheet = {
  client: { firstName: "María José", lastName: "del Río de la Fuente", dateOfBirth: "2019-07-02" },
  schools: ["Escuela San Juan Bosco"],
  addresses: ["15 Calle del Mar, Apto 2, Hialeah, FL 33010"],
  ids: ["A12345678"],
};

export const COMPOUND_SHEET: ClientSheet = { client: { firstName: "María José", lastName: "del Río de la Fuente", dateOfBirth: "2019-07-02" } };
export const RESTORE_COMPOUND: Array<[string, string, string]> = [
  // [the text, what the model writes, what must come back]
  ["Mª José y Ma. José; José dijo hola; Señora María (otra persona).", "", "Mª José y Ma. José; José dijo hola; Señora María (otra persona)."],
  ["la Fuente y De La Fuente; Delrío; del Río, María José; la familia del Río-de la Fuente.", "", "la Fuente y De La Fuente; Delrío; del Río, María José; la familia del Río-de la Fuente."],
  ["cumple el 2/7. born July 2nd.", "Her birthday is [DOB MONTH AND DAY 2].", "Her birthday is July 2nd."],
];

/** Clinical text with title words, labels and places that must come through as written (review round 2, H1 and H2). */
export const CLINICAL_ROUND2 = [
  "BASC-3 Teacher Rating Scales (TRS)",
  "CBCL Teacher Report Form",
  "Vineland-3 Teacher Rating Form",
  "Teacher Interview, Teacher Questionnaire, Coach Training Program, Nana Plus app",
  "Miss Trials: 3",
  "Rater: Teacher. Respondent: Mother.",
  "Grace period; Mark the data; Will they?; Florida Medicaid; Parent Training Goals; Code 97153; Room 33135; Page 33101; Total 33012",
];

/**
 * Texts that must come back as written after de-identification (review round 2: H2 lost a word, H3 restored another
 * school), and, for names, what comes back: the same words in the sheet's spelling (a broken, OCR-misread or
 * fullwidth name word comes back clean; a first name or a nickname as the preferred name, the owner's rule).
 */
export const RESTORE_NAMES: Array<[string, string]> = [
  // A name without its accents, fullwidth, broken or misread: as written.
  ["Lucia Fic-ticio and Valeria Ficticio Go-mez; Ｍａｔｅｏ; Luc1a; Mar-tí Elementary.", "Lucia Fic-ticio and Valeria Ficticio Go-mez; Ｍａｔｅｏ; Luc1a; Mar-tí Elementary."],
  ["Valeria Ficticio and Valeria Ficticio Gómez; Ficticio, Mateo; Mateo F.", "Valeria Ficticio and Valeria Ficticio Gómez; Ficticio, Mateo; Mateo F."],
];

export const RESTORE_EXACT = [
  "Visited 4471 SW 12th Terrace, Miami. Mother said he sleeps well.",
  "We met at 4471 SW 12th Terrace, Miami. Lives Here.",
  "He attends José Martí Elementary School and will go to José Martí Middle School.",
  "Lives on SW 12th Terrace near the park; 4471 SW 12th Terr., Unit 3, Miami FL 33135; 4471 S.W. 12 Terrace #3.",
  "Call 555-0142 or (305) 555-0142; ID FL 123 - 456 - 789 or 123456789.",
  "La abuela, Sra. Gómez, cuida a Mateo. The Ficticio family; Ficticio said.",
];

/** What must survive whatever the sheet: clinical terms, codes, scores. */
export const CLINICAL = [
  "Vineland-3 ABC 66 (62-70), percentile 1, age equivalent 1:6",
  "ADOS-2 Module 3, comparison score 7; SRS-2 T-score 76; CARS-2 34.5",
  "VB-MAPP Level 2; ABLLS-R; BASC-3 PRQ; CBCL; M-CHAT-R/F",
  "CPT 97151, 97153, 97155, 97156, 97157, 97158, 0362T, 0373T",
  "ICD-10 F84.0, F88, F90.2, Z13.41, R62.50",
  "Recommended 97153 RBT services 20 hours per week; 97155 supervision 4 hours.",
  "from 8:00 to 14:00, 2 to 4 times per week; Florida Statute 393.17",
  "he will need help; hope is high; a rose; mark the box; it may rain",
  "Code 97153 and Procedure 97155 and Total 33533 units",
];

/** What models do to placeholders: [what the model wrote, what must come back, whether it must be reported]. */
export const REIDENTIFY_SOURCE = "Mateo, his mother Lucía and Lucía Ficticio. DOB 03/14/2020. Andrés.";
export const REIDENTIFY_CASES: Array<[string, string, boolean]> = [
  ["[CLIENT NAME]", "[CLIENT NAME]", true],
  ["[Client's name]", "[Client's name]", true],
  ["[CLIENT FIRST NAME]", "[CLIENT FIRST NAME]", true],
  ["[CLIENT 1]", "[CLIENT 1]", true],
  ["[CLIENT FULL]", "[CLIENT FULL]", true],
  ["[CLIENT'S FULL NAME]", "[CLIENT'S FULL NAME]", true],
  ["[CAREGIVER 1 AND 2]", "[CAREGIVER 1 AND 2]", true],
  ["[DOB MONTH AND YEAR]", "[DOB MONTH AND YEAR]", true],
  ["[DOB'S]", "[DOB'S]", true],
  ["[CAREGIVER 3]", "[CAREGIVER 3]", true],
  ["[SIBLING 1]", "[SIBLING 1]", true],
  ["[MOTHER]", "[MOTHER]", true],
  ["[CLIENTE]", "[CLIENTE]", true],
  ["[CUIDADOR 1]", "[CUIDADOR 1]", true],
  ["CLIENT INFORMATION", "CLIENT INFORMATION", true],
  ["[CLIENT] and [Client] and [client]", "Mateo and Mateo and Mateo", false],
  ["[CLIENT]'s and [CLIENT’S] and [CLIENT'S]", "Mateo's and Mateo’s and Mateo's", false],
  ["[CAREGIVER_1] [CAREGIVER-1] [CAREGIVER1] [caregiver 1]", "Lucía Lucía Lucía Lucía", false],
  ["{CLIENT} <CLIENT> [[CLIENT]] \\[CLIENT\\]", "Mateo Mateo Mateo Mateo", false],
  ["(CLIENT) and (client)", "Mateo and (client)", false],
  ["[CLIENT and CAREGIVER 1]", "[CLIENT and CAREGIVER 1]", true],
  ["[CLIENT went home", "Mateo went home", false],
  ["went home CLIENT]", "went home Mateo", false],
  ["**[CLIENT]** and *[CAREGIVER 1]*", "**Mateo** and *Lucía*", false],
  ["CAREGIVER 1 FULL NAME signed", "Lucía Ficticio signed", false],
  ["[CLIENT INITIALS].", "M.F.", false],
  ["[DOB]", "03/14/2020", false],
  ["See [the notes](notes.md) [sic]", "See [the notes](notes.md) [sic]", false],
];

// ---------------------------------------------------------------- review round 4

/** Round 4's leaks on the main sheet (B1 to B4): separators the matcher did not accept, the ZIP alone, OCR digits, page breaks. */
export const R4_PROBES: Probe[] = [
  ...["03\\14\\2020", "03,14,2020", "03;14;2020", "03 , 14 , 2020", "03~14~2020", "03+14+2020", "03=14=2020", "03>14>2020"].map((d) => ({ group: "B1 separators", text: `DOB ${d}.`, hide: [d, "14"] })),
  ...["305\\555\\0142", "305,555,0142", "305; 555; 0142", "305~555~0142", "305+555+0142", "305=555=0142"].map((p) => ({ group: "B1 separators", text: `Call ${p} today.`, hide: [p, "0142"] })),
  { group: "B1 separators", text: "Medicaid FL 123,456,789 and FL~123~456~789; other ID 98,765,432,10.", hide: ["123,456,789", "123~456~789", "98,765,432,10"] },
  { group: "B2 ZIP", text: "33135-0000; ZIP+4 33135-4471; Hialeah,FL,33135; FL,33135.", hide: ["33135"] },
  { group: "B3 OCR digits", text: "DOB O3/I4/2O2O, phone 3O5-555-O142 and 305-555-0l42.", hide: ["O3/I4/2O2O", "3O5-555-O142", "0l42"] },
  { group: "B3 OCR digits", text: "DOB 0\u{0417}/14/2020 and \u{0660}\u{0663}/\u{0661}\u{0664}/\u{0662}\u{0660}\u{0662}\u{0660}.", hide: ["14/2020", "\u{0661}\u{0664}"] },
  { group: "B4 page break", text: "Phone: (305) 555-\n\n--- Page 2 of 3 ---\n0142 (continued). DOB 03/14/\n\n--- Page 2 of 3 ---\n2020.", hide: ["305", "555", "0142", "03/14"] },
  { group: "B4 page break", text: "DOB 03/14/\n\n--- Page 1 of 2 ---\n", hide: ["03/14"] },
];

/** Round 4's Spanish-sheet leaks (B1, B2, B5). */
export const R4_SPANISH_PROBES: Probe[] = [
  { group: "B1 separators", text: "ID A12,345,678.", hide: ["12,345,678"] },
  { group: "B2 ZIP", text: "33010-1234; Hialeah,FL,33010.", hide: ["33010", "Hialeah"] },
  { group: "B5 street", text: "15 Cll. del Mar; 15 Cal. del Mar; 15 Clle. del Mar.", hide: ["Cll. del Mar", "Cal. del Mar", "Clle. del Mar"] },
  { group: "B5 school", text: "Va a S.J.B., a S J B, a E.S.J.B. y a escuela sanjuanbosco; la escuela Juan Bosco.", hide: ["S.J.B", "S J B", "E.S.J.B", "sanjuanbosco", "Juan Bosco"] },
];

/** H2: no span across a sentence end, labels stay, nothing re-split: [text, what is sent]. The date of birth restores as MM/DD/YYYY. */
export const R4_SPANS: Array<[string, string, string]> = [
  ["Born: 3 14 2020. 03 14 20.", "Born: [DOB]. [DOB 2].", "Born: 3 14 2020. 03 14 20."],
  ["Birth month: March; birth day: 14; birth year: 2020.", "Birth month: [DOB MONTH]; birth day: [DOB DAY]; birth year: 2020.", "Birth month: March; birth day: 14; birth year: 2020."],
  ["In 2020. 03 14 kids came.", "In 2020. 03 14 kids came.", "In 2020. 03 14 kids came."],
];

/** H1: score rows with numbers that equal a short sheet value: sent as they are, and listed for review. [sheet change, the row]. */
export const R4_SCORE_ROWS: Array<[{ dateOfBirth?: string; address?: string }, string]> = [
  [{ dateOfBirth: "2013-06-22" }, "Communication | Expressive | 22 | 6 | 1:3 | Low"],
  [{ dateOfBirth: "2014-03-19" }, "Raw scores | 21 | 7 | 19 | 3 | 14 | 20"],
  [{ dateOfBirth: "2012-01-10" }, "Item 4 | 1 | 1 | 0 | 2 | 0 | 1 | 2 | 1 | 0 | 2 | 0 | 1"],
  [{ dateOfBirth: "2012-01-02" }, "Item 2 | 1 | 2 | 0 | 1 | 2 | 1 | 2 | 0 | 1 | 2 | 1 | 2"],
  [{ dateOfBirth: "2019-11-05" }, "11 5 19 trials and 5 11 19 correct."],
  [{ address: "102 NW 5th St, Miami, FL 33128" }, "Receptive | 1 | 0 | 2 | 2 | 1 | 0"],
  [{ address: "102 NW 5th St, Miami, FL 33128" }, "Raw 1 0 2; score 1 0 2; Trials 1-0-2 and 1:0:2; Tact 1 | 0 | 2."],
  [{ address: "102 NW 5th St, Miami, FL 33128" }, "CPT 97151 x 1 0 2 units."],
];

// ---------------------------------------------------------------- review round 5

/** Round 5's leaks on the main sheet: the four-digit-year DOB in any layout, short forms by the client's name, birthday words, the house number alone. */
export const R5_PROBES: Probe[] = [
  { group: "B1 DOB in any layout", text: "Client: Mateo Ficticio | 03 | 14 | 2020 | M | 6:8", hide: ["03 | 14 | 2020", "Mateo"], keep: ["| M | 6:8"] },
  { group: "B1 DOB in any layout", text: "Date of Birth:\n------------\n3 | 14 | 2020", hide: ["3 | 14 | 2020"] },
  { group: "B1 DOB in any layout", text: "Intake | 3 14 2020 | referral", hide: ["3 14 2020"] },
  { group: "B1 DOB in any layout", text: "Mateo, 3 14 20, ABA.", hide: ["3 14 20"] },
  { group: "B1 DOB in any layout", text: "Mateo b. 3 14 20.", hide: ["3 14 20"] },
  { group: "B1 DOB in any layout", text: "Date of Birth\n\n_____\n3 14 20", hide: ["3 14 20"] },
  { group: "B2 birthday words", text: "Bday 3 14", hide: ["3 14"] },
  { group: "B2 birthday words", text: "cumple 14 3", hide: ["14 3"] },
  { group: "B2 birthday words", text: "Birthday | 3 | 14 |", hide: ["3 | 14"] },
  { group: "B2 birthday words", text: "Su cumpleaños es el 14 3.", hide: ["14 3"] },
  { group: "H3 house number", text: "dirección 4471; house number 4471; lives at # 4471.", hide: ["4471"] },
];

/** H1: ratios equal to the birthday read either way stay as written. */
export const R5_RATIOS: string[] = [
  "Rates: 3 per hour, 1.5 per minute, 12 of 20 opportunities, 8/10, 9/10, 7/10, 6/10",
  "Tact: 3/14 correct; Mand: 14/3 trials.",
  "Accuracy 3/14 on the first probe.",
  "Trials | 3/14 | 8/10 | 9/10",
];

/** H2: names in another case or without their accents restore exactly as written. */
export const R5_RESTORE: string[] = [
  "Lucia Fic-ticio, LUCÍA, lucía and Lucia came.",
  "MATEO and mateo; VALERIA FICTICIO GÓMEZ and Valeria Ficticio Gomez.",
  "Andres and ANDRES; ficticio gómez.",
  "Call [305] 555 0142 or {305}5550142.",
];

// ---------------------------------------------------------------- review round 6

/** Round 6's leaks on the main sheet: overlapping date-of-birth readings, names spelled with dots or held letters, school short forms. */
export const R6_PROBES: Probe[] = [
  { group: "B1 overlapping readings", text: "Date of birth | 03 14 2020 | 03 14 2020", hide: ["03 14", "2020"] },
  { group: "B1 overlapping readings", text: "3 14 2020 3 14", hide: ["3 14", "2020"] },
  { group: "B1 overlapping readings", text: "3 14 | 03 14 2020", hide: ["3 14", "2020"] },
  { group: "B1 overlapping readings", text: "DOB 3 14 2020 3 14 2020 and Child | 03 | 14 | 2020 | 03 | 14 | 2020", hide: ["3 14", "2020", "03 | 14"] },
  { group: "B2 spelled names", text: "He wrote M.A.T.E.O. on the board, then M_A_T_E_O and L.U.C.I.A.", hide: ["M.A.T.E.O", "M_A_T_E_O", "L.U.C.I.A"] },
  { group: "B2 spelled names", text: "She called 'Mateooo!' and MATEOOO! and Mmmateo.", hide: ["Mateooo", "MATEOOO", "Mmmateo"] },
  { group: "B3 school short forms", text: "Attends Marti ES; transferred from JM Elementary; JM ES PTA; Martí MS next year.", hide: ["Marti ES", "JM Elementary", "JM ES", "Martí MS"] },
];

/** Round 6's over-hiding: clinical lines that must come through unchanged, with the birth date that used to change them. */
export const R6_CLINICAL: Array<[string, string]> = [
  ["2012-03-14", "In March, 14 sessions were held; in April, 12 sessions; by May, 10 targets mastered."],
  ["2019-02-05", "Norms for ages 2-5, 2019 edition; ages 6-11, 2020 edition."],
  ["2020-03-14", "Ages 3–14 (2020 norms)"],
  ["2018-02-07", "Trials by year: 12 | 2 7 2018 2019"],
  ["2019-11-05", "Raw 11 | 5 | 2019 norm table | 14"],
  ["2020-03-14", "Score table: 3 | 14 | 2020 | norms"],
  ["2020-03-14", "Grade 3, 14 students, 2020 cohort"],
];

/** Round 6's house-number over-hiding (house number 102): counts and codes stay; the house number after its own word is hidden. */
export const R6_HOUSE_KEEP = ["Street-crossing program: 102 trials.", "Lives nearby; 102 correct responses.", "Casa: 102 ensayos.", "ABLLS-R item C102. Seen at clinic suite 102.", "CPT 97153 x 102 units."];

// ---------------------------------------------------------------- review round 7

/** Round 7's sheet with three-letter names. */
export const SHORT_SHEET: ClientSheet = {
  client: { firstName: "Ana", lastName: "Paz Gil", nicknames: ["Ani"], dateOfBirth: "2018-09-05" },
  caregivers: [
    { firstName: "Eva", lastName: "Gil", relation: "mother" },
    { firstName: "Luz", lastName: "Rey", relation: "grandmother" },
  ],
  schools: ["Escuela Sol"],
  addresses: ["9 Calle Mar, Doral"],
};

/** B1: three-letter names spelled out, or joined in lowercase in handles, sites and file names. */
export const R7_PROBES: Probe[] = [
  { group: "B1 spelled", text: "She wrote A-N-A on the board.", hide: ["A-N-A"] },
  { group: "B1 spelled", text: "Spelled A N A.", hide: ["A N A"] },
  { group: "B1 spelled", text: "Then a.n.a. and E.V.A. and L-U-Z.", hide: ["a.n.a", "E.V.A", "L-U-Z"] },
  { group: "B1 joined", text: "Follow @anapaz or www.anapaz.com; file ana_paz_cde.pdf; evarey@mail.com.", hide: ["anapaz", "paz_cde", "ana_", "evarey"] },
];

/** H1: names broken across a line break restore exactly, the break kept. */
export const R7_RESTORE: string[] = [
  "Ma-\nteo cried. Lucía Fic-\nticio said.",
  "Ma-\nteo Fic-\nticio Gó-\nmez; Lu-\ncía",
  "Mateo\nFicticio Gómez and Ficticio\nGómez; Mateo\tFicticio.",
  "Call 305-555-\n0142 or 305-555- 0142.",
];

/** H2, H3: clinical lines that stay as written, with the birth date that used to change them. */
export const R7_CLINICAL: Array<[string, string]> = [
  ["2019-01-02", "Session 12 — 2019 plan"],
  ["2019-01-02", "VB-MAPP 12 2019"],
  ["2019-01-02", "Mand 12 | 2019 update"],
  ["2019-01-02", "Scored 12 in 2019. 12/2019 manual."],
  ["2020-01-04", "Mand 3 | Tact 14 | 2020 goal bank"],
  ["2020-03-14", "Bday week data: 8/10, 3/14, 9/10, 2/7, 11/5."],
  ["2012-08-10", "On his birthday he scored 8/10 on mands and 3/14 on tacts."],
  ["2014-06-18", "Born premature; Apgar 7/9; birth weight 6 lb 14 oz"],
  ["2020-03-14", "Born premature, 3/14 Apgar"],
];
