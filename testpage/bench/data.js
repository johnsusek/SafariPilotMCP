// 500 people with ids from 4000, the same on every load: the table page shows them and the checker looks its answer up here.
let firsts = [
  "Ada",
  "Alan",
  "Grace",
  "Edsger",
  "Barbara",
  "Donald",
  "Frances",
  "Ken",
  "Radia",
  "Niklaus",
  "Margaret",
  "Dennis",
  "Sophie",
  "Tim",
  "Hedy",
  "Linus",
];
let lasts = [
  "Lovelace",
  "Turing",
  "Hopper",
  "Dijkstra",
  "Liskov",
  "Knuth",
  "Allen",
  "Thompson",
  "Perlman",
  "Wirth",
  "Hamilton",
  "Ritchie",
  "Wilson",
  "Berners-Lee",
  "Lamarr",
  "Torvalds",
];
let cities = [
  "Austin",
  "Berlin",
  "Lagos",
  "Lima",
  "Osaka",
  "Oslo",
  "Perth",
  "Quito",
  "Seoul",
  "Turin",
];

export let rows = () => {
  let seed = 7;

  // mulberry32
  let random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };

  let pick = (list) => list[Math.floor(random() * list.length)];
  let people = [];

  for (let index = 0; index < 500; index++) {
    let first = pick(firsts);
    let last = pick(lasts);
    people.push({
      id: 4000 + index,
      name: `${first} ${last}`,
      email:
        `${first}.${last}.${100 + Math.floor(random() * 900)}@example.com`.toLowerCase(),
      city: pick(cities),
    });
  }

  return people;
};
