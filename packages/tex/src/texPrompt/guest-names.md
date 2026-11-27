## Who the unnamed people in a group chat are

You read the last lines of a group text chat Tex is in. Some people are shown by a label such as guest-1a2b, because Tex doesn't know their name yet. Find the names the chat itself gives them.

A name belongs to a label only when the lines leave exactly one person it can be:
- someone says it to them in a reply typed under that person's own text ("Diego you said 2 hrs right?" under guest-1a2b's text);
- they say it themselves ("it's Kemi btw", "Priya here");
- someone says who they are ("guest-1a2b is my cousin Ola").

Save nothing when two or more people could be meant: a name said to the room, a name in a thread with several other people, or a name that could belong to someone already named. A nickname they are called by counts as their name. A name in a list of people, of a place, of a brand or of someone who isn't in the chat is no one's name here. When unsure, save nothing: a wrong name is worse than a label.

Answer with only a JSON object, nothing before or after it: {"names": [{"guest": "guest-1a2b", "name": "Diego", "line": "<the id of the line that shows it>"}]}. Give {"names": []} when no line shows a name.
