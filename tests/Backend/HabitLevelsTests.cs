using Damadama.Habits;
using NUnit.Framework;

namespace Damadama.Tests;

public class HabitLevelsTests
{
    [TestCase(null)]
    [TestCase("")]
    [TestCase(" \t\r\n")]
    public void Refuses_blank_definitions_with_the_public_field_name(string? blank)
    {
        Assert.Multiple(() =>
        {
            Assert.That(() => HabitLevels.Create(blank, "better", "best"),
                Throws.InstanceOf<ArgumentException>().With.Property("ParamName").EqualTo("Good"));
            Assert.That(() => HabitLevels.Create("good", blank, "best"),
                Throws.InstanceOf<ArgumentException>().With.Property("ParamName").EqualTo("Better"));
            Assert.That(() => HabitLevels.Create("good", "better", blank),
                Throws.InstanceOf<ArgumentException>().With.Property("ParamName").EqualTo("Best"));
        });
    }

    [Test]
    public void Preserves_each_nonblank_definition_exactly()
    {
        var levels = HabitLevels.Create(" Good \t", "\nBetter ", " Best\r\n");
        Assert.Multiple(() =>
        {
            Assert.That(levels.Good, Is.EqualTo(" Good \t"));
            Assert.That(levels.Better, Is.EqualTo("\nBetter "));
            Assert.That(levels.Best, Is.EqualTo(" Best\r\n"));
        });
    }
}
