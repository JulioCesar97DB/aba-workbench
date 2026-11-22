/*
 * Given names and surnames that are also ordinary English or Spanish words. A name on
 * the sheet that is one of these ("Will", "Hope", "Rosa", "Cruz", "Brown") is
 * handled by the ambiguous-name rule in names.ts instead of being hidden everywhere,
 * so "he will need" and "una rosa" stay readable. Words are folded (lowercase, no
 * accents). Any name part of one or two letters ("Al", "Bo") is treated the same way.
 */

const ENGLISH = `
will hope grace joy faith mark rose bill pat sunny summer autumn april may june august
dawn eve ivy lily amber ruby jade crystal angel hunter chase rich frank sue jack bob art
bud guy ray wade drew rod gene sky river storm misty honey candy cherry destiny harmony
heaven melody star raven robin jay wren hazel olive violet daisy iris holly heather ginger
penny carol charity patience prudence constance mercy trinity journey legend king royal
prince duke earl baron major page rocky buck colt fox wolf bear gray grey brown black
white green young long short little small strong wise love golden silver stone wood woods
hill hills lake field fields banks park parks bush ford price cook baker miller hall wall
rice bell case cash west north south east best good hart hardy moody noble sharp swift
sweet house glass salt snow frost winter spring day knight chance miles lane dean sterling
shepherd mason ward bishop pope church law gay rush bliss blue reed rivers worth cross
lamb fisher hunt marsh moss pierce power rose wells weeks wood young sage clay cliff
glen dale dell grant gil hal lance sandy rusty skip chip sonny buddy kit kitty bunny
dolly molly polly peg patty sally tammy terry trey harry jimmy billy willy bobby
`;

const SPANISH = `
luz paz rosa rosario pilar dolores mercedes consuelo soledad amparo rocio alegria
esperanza cruz blanca clara angeles salvador jesus concepcion asuncion encarnacion
remedios socorro milagros gracia fe victoria aurora estrella perla paloma flor marina sol
cielo alba nieves reyes rey leon lobo cordero toro gallo pastor moreno blanco negro rubio
delgado bravo leal franco santos santo campos vega mora prieto nieto rios rio montes
monte sierra castillo iglesias iglesia cabello calvo serrano pena ramos rojo rojas roja
salas sala torres torre valle puerto lago llano mesa palma plata oro piedra camino
ventura amor caridad felicidad linda bonita perfecto justo modesto inocencio benigno
casto feliz alegre lucero cristal angel trinidad gloria belen fortuna primavera
dulce armando domingo cuba duque conde marques obispo caballero escudero
herrero pinto bueno malo parra rubi oliva olivo naranjo manzano cano chico
`;

export const COMMON_WORD_NAMES: ReadonlySet<string> = new Set(`${ENGLISH} ${SPANISH}`.split(/\s+/).filter(Boolean));

/** True for a folded name part that is also an everyday word, or is too short to be safe. */
export function isCommonWordName(folded: string): boolean {
  return folded.length <= 2 || COMMON_WORD_NAMES.has(folded);
}
