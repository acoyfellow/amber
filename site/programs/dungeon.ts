declare function tool<T>(name: string, args: unknown): T;
declare function print(s: string): void;

const choose = (text: string, options: string[]): number => {
  for (;;) {
    const pick = tool<number>("choose", { text, options });
    if (Number.isInteger(pick) && pick >= 0 && pick < options.length) return pick;
    print("That is not one of the doors.");
  }
};

let seed = Date.now() % 2147483647;
const roll = (sides: number): number => {
  seed = (seed * 48271) % 2147483647;
  return 1 + (seed % sides);
};

const hero = { hp: 10, maxHp: 10, gold: 0, slain: 0, items: new Set<string>() };
const say = (line: string) => print(line);

const fight = (name: string, hp: number, hit: number): boolean => {
  while (hp > 0) {
    const potion = hero.items.has("potion");
    const move = choose(`The ${name} has ${hp} hp. You have ${hero.hp}.`, ["Attack", potion ? "Drink the potion" : "Run"]);
    if (move === 1 && potion) {
      hero.items.delete("potion");
      hero.hp = hero.maxHp;
      say("You drink the potion. Fully healed.");
    } else if (move === 1) {
      if (roll(2) === 1) { say(`You outrun the ${name}.`); return false; }
      say("You trip over your own feet.");
    } else {
      const damage = roll(4) + (hero.items.has("sword") ? 2 : 0);
      hp -= damage;
      say(`You hit the ${name} for ${damage}.`);
    }
    if (hp > 0) {
      const taken = roll(hit);
      hero.hp -= taken;
      say(`The ${name} hits you for ${taken}.`);
      if (hero.hp <= 0) return false;
    }
  }
  const loot = roll(6);
  hero.slain++;
  hero.gold += loot;
  say(`The ${name} falls. You find ${loot} gold.`);
  return true;
};

const rooms = [
  () => { say("A goblin blocks the corridor, sharpening a spoon."); fight("goblin", 5, 3); },
  () => {
    const pick = choose("A dusty chest sits in the corner.", ["Open it", "Kick it", "Leave it"]);
    if (pick === 0 && roll(3) === 1) { hero.hp -= 3; say("It was a mimic. It bites you for 3."); }
    else if (pick === 0) { hero.items.add("sword"); say("Inside: a sword. Your hits land harder."); }
    else if (pick === 1) { const gold = roll(8); hero.gold += gold; say(`It cracks open. ${gold} gold spills out.`); }
    else say("You leave it alone. Probably wise.");
  },
  () => {
    const pick = choose("A glowing fountain hums at you.", ["Drink", "Toss in a coin", "Walk on"]);
    if (pick === 0) { hero.maxHp += 2; hero.hp = hero.maxHp; say("You feel tougher. Max hp +2."); }
    else if (pick === 1 && hero.gold > 0) { hero.gold--; hero.items.add("luck"); say("The fountain takes your coin. You feel lucky."); }
    else if (pick === 1) say("You have no coin. The fountain looks disappointed.");
    else say("You walk on.");
  },
  () => {
    const pick = choose(`A merchant grins. "Potion, 5 gold." You have ${hero.gold}.`, ["Buy one", "Rob him", "No thanks"]);
    if (pick === 0 && hero.gold >= 5) { hero.gold -= 5; hero.items.add("potion"); say("You buy a potion."); }
    else if (pick === 0) say('"Come back richer," he says.');
    else if (pick === 1) { say("He was a wizard. Of course he was."); fight("angry wizard", 8, 4); }
    else say("You nod and move on.");
  },
  () => {
    say("Spikes shoot out of the floor!");
    const taken = hero.items.has("luck") ? 0 : roll(4);
    hero.hp -= taken;
    say(taken > 0 ? `You take ${taken} damage.` : "Your luck holds. Not a scratch.");
  },
];

const FLOORS = 5;
let floor = 0;
say("You wake at the top of a staircase that goes down a long way.");

while (hero.hp > 0 && floor < FLOORS) {
  floor++;
  say(`~ Floor ${floor} ~`);
  rooms[roll(rooms.length) - 1]();
  if (hero.hp > 0 && floor < FLOORS) {
    const pick = choose(`Floor ${floor} cleared. ${hero.hp}/${hero.maxHp} hp, ${hero.gold} gold.`, ["Go deeper", "Rest (heal 3)"]);
    if (pick === 1) { hero.hp = Math.min(hero.maxHp, hero.hp + 3); say("You rest. Something nibbles your boot."); }
  }
}

let ending = "You died in the dark.";
if (hero.hp > 0) {
  say("At the bottom: a dragon. Very awake.");
  ending = fight("dragon", 14, 5) ? "You slew the dragon." : hero.hp > 0 ? "You fled the dragon. Alive, at least." : "The dragon wins.";
}
say(ending);

({ ending, floor, hp: hero.hp, gold: hero.gold, slain: hero.slain, items: [...hero.items] });
