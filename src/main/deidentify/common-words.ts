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

/**
 * Everyday English and Spanish words, folded: two of these separated by a space ("a dam",
 * "no el", "to mas") are ordinary text, not a sheet name split in two, so they are
 * reported for review, never hidden. A word missing here errs on the side of hiding.
 */
const EVERYDAY = `
a an and the of to in on at by for or as is it its be am are was were been being he she we they them their there this that these those
my his her our your you me us him i if so do does did done no not yes up down out off over under into onto from with without about
after before again all any both each few more most other some such only own same than too very can will just should now then here
when where why how what which who whom whose while because until also even ever still yet well back away way day days time times year
years one two three four five six seven eight nine ten first last next new old good bad big small long short high low little much many
man men woman women boy boys girl girls child kid kids mom mum dad baby home house room school class park car bus dog cat toy toys
play plays played go goes went gone come came get got give gave take took make made see saw look looked say said tell told ask asked
want wanted need needed like liked love help helped run ran walk eat ate drink sleep slept sit sat stand cry cried hit bite bit kick
throw threw push pull hold open close read write draw sing talk talked call called work works worked use used try tried keep kept
let put set turn turned move moved stop start started show showed find found think thought know knew feel felt leave left bring brought
hand hands head face eye eyes ear arm arms leg legs foot feet body door floor wall table chair bed book books ball game games word words
dam mat ate ten tea sea sun son air art end age ago ant bay bee bow box cap cow cup cut dot due ear egg era fan far fat fig fit fix fly fog
fun gas gap gum gun hat hay hen hip hot ice ink jam jar jaw jet job joy key kin lab lap law lay leg lid lie lip log lot mad map mix mob
mud nap net nod nor nut oak oil owl pad pan pen pet pie pig pin pit pot raw ray red rib rid rim rod row rub rug sad sap saw sew sip sir
six ski sky sly sow spa spy tab tag tan tap tar tax tie tin tip toe ton top tow toy tub tug van vet war wax web wet win wit yes zip
mate mates matter rate rates late lane line lines tick ticks res mas
de del la las los el y e o u en un una unos unas con por para sin sobre entre hasta desde hacia contra segun durante mediante
al lo le les me mi mis te tu tus se su sus nos os yo tu el ella ellos ellas usted ustedes nosotros que quien cual cuando donde como
porque pues pero mas menos muy mucho mucha muchos muchas poco poca pocos todo toda todos todas nada algo alguien nadie cada otro otra
otros otras mismo misma este esta estos estas ese esa esos esas aquel aquella si no ya aun tambien tampoco solo siempre nunca hoy ayer
manana tarde noche dia dias ano anos mes semana hora horas vez veces casa escuela clase nino nina ninos ninas mama papa bebe hermano
hermana abuelo abuela tio tia padre madre hijo hija familia amigo amiga perro gato juego juegos agua leche pan comida mesa silla cama
puerta piso mano manos cabeza cara ojo ojos boca pie pies es son fue era eran ser estar esta estan estaba estuvo hay habia tiene tienen
tenia tuvo hace hizo hacer va van fue ir dice dijo decir puede pueden podia quiere quieren queria sabe sabia ve vio ver da dio dar
come comio comer juega jugo jugar llora lloro llorar corre corrio correr sale salio salir pone puso poner toma tomo tomar mira miro
mirar pide pidio pedir dame bien mal mejor peor grande pequeno nuevo viejo alto bajo poco rato luego antes despues ahora entonces
mar sol luz paz fe mal ma da va ve vi vio fin ser sea son tan tal ves vas mas mes pez voz sal res red pan sin ten sur
na
`;
const EVERYDAY_WORDS: ReadonlySet<string> = new Set(EVERYDAY.split(/\s+/).filter(Boolean));

/** True for a folded everyday word (or a common-word name): one piece of a possible split that ordinary text could hold. */
export function isEverydayWord(folded: string): boolean {
  return EVERYDAY_WORDS.has(folded) || COMMON_WORD_NAMES.has(folded);
}
