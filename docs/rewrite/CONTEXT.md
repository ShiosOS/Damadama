# Damadama

Damadama is a habit journal. This glossary records the terminology used in the rewrite's requirements.

## Language

**account**:
The identity to which a person's habits, schedules, and entries belong.

**habit**:
A named practice with definitions for Good, Better, and Best and its own recurring schedule.

**tier definition**:
The person's description of what Good, Better, or Best means for one habit.

**schedule**:
A habit's calendar-based repeat rule identifying its scheduled dates.

**schedule history**:
The preserved rules needed to determine which dates a habit was scheduled on in the past.

**scheduled date**:
A calendar date on which a habit's applicable schedule calls for that habit.

**calendar date**:
The fixed date associated with an entry, separate from the instant at which the entry was edited.

**Today**:
The current calendar date in the device's current timezone.

**daily entry**:
A recorded Good, Better, Best, or Rest selection for one habit on one scheduled calendar date.
_Avoid_: task, todo.

**result**:
The selection recorded in a daily entry: Good, Better, Best, or Rest.

**Rest**:
A recorded Rest selection, distinct from an absent entry.
_Avoid_: Skip.

**missed date**:
A past scheduled date for which there is no daily entry.

**loggedAt**:
The timestamp of an entry change, distinct from its calendar date and from the time a retry reaches the server.

**pending entry change**:
A device-persisted selection change whose server outcome has not yet been confirmed.

**combined heatmap**:
A year view combining the points earned across habits scheduled on each calendar date.

**daily maximum**:
Three times the number of habits scheduled on a calendar date, including habits with Rest entries.
