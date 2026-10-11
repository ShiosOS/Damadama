using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace Damadama.Migrations
{
    /// <inheritdoc />
    public partial class InitialHabits : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.CreateTable(
                name: "Habits",
                columns: table => new
                {
                    Id = table.Column<Guid>(type: "uuid", nullable: false),
                    OwnerId = table.Column<string>(type: "text", nullable: false),
                    Name = table.Column<string>(type: "text", nullable: false),
                    Good = table.Column<string>(type: "text", nullable: false),
                    Better = table.Column<string>(type: "text", nullable: false),
                    Best = table.Column<string>(type: "text", nullable: false),
                    CreatedAt = table.Column<DateTimeOffset>(type: "timestamp with time zone", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Habits", x => x.Id);
                });

            migrationBuilder.CreateTable(
                name: "InitialSchedules",
                columns: table => new
                {
                    HabitId = table.Column<Guid>(type: "uuid", nullable: false),
                    Weekdays = table.Column<int[]>(type: "integer[]", nullable: false),
                    RepeatEveryWeeks = table.Column<int>(type: "integer", nullable: false),
                    TimeZone = table.Column<string>(type: "text", nullable: false),
                    CreationDate = table.Column<DateOnly>(type: "date", nullable: false),
                    FirstWeekMonday = table.Column<DateOnly>(type: "date", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_InitialSchedules", x => x.HabitId);
                    table.CheckConstraint("PositiveRepeat", "\"RepeatEveryWeeks\" > 0");
                    table.CheckConstraint("SelectedWeekdays", "cardinality(\"Weekdays\") > 0 AND \"Weekdays\" <@ ARRAY[1,2,3,4,5,6,7]");
                    table.ForeignKey(
                        name: "FK_InitialSchedules_Habits_HabitId",
                        column: x => x.HabitId,
                        principalTable: "Habits",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Cascade);
                });

            migrationBuilder.CreateIndex(
                name: "IX_Habits_OwnerId_CreatedAt",
                table: "Habits",
                columns: new[] { "OwnerId", "CreatedAt" });
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropTable(
                name: "InitialSchedules");

            migrationBuilder.DropTable(
                name: "Habits");
        }
    }
}
